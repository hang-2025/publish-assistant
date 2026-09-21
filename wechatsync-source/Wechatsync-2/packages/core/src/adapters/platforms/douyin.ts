/**
 * 抖音受保护文章草稿适配器。
 *
 * 只在当前 Chrome 已登录的 creator.douyin.com“发布文章”页面中驱动官方
 * 编辑器，等待页面自己的自动保存，并从编辑器与草稿 URL 回读。publish()
 * 永久拒绝；这里不会点击“发布”或“预览并发布”。
 */
import { CodeAdapter } from '../code-adapter'
import type { Article, AuthResult, PlatformMeta, SyncResult } from '../../types'
import type { PublishOptions } from '../types'
import type { CanonicalArticle, CanonicalBlock, FidelityCheck, FidelityReport } from '../../article/canonical'
import { assertCaptionPolicy, parseCanonicalArticle, renderCanonicalArticle, validateCanonicalFidelity } from '../../article/canonical'
import { createLogger } from '../../lib/logger'
import { buildDouyinImportDocx } from './douyin-docx'

const logger = createLogger('Douyin')
const PUBLISH_URL = 'https://creator.douyin.com/creator-micro/content/upload?page=article'

type DouyinPageResult = {
  ok: boolean
  error?: string
  draftId?: string
  url?: string
  title?: string
  html?: string
  bodyText?: string
  imageCount?: number
  savedText?: string
  summary?: string
  captions?: string[]
}

function normalize(value: string): string { return String(value || '').replace(/[\s\u200B-\u200D\uFEFF]+/g, ' ').trim() }

function lengthOf(value: string): number { return Array.from(value).length }

function withinSummaryLimit(value: string): string {
  const cleaned = normalize(value).replace(/^[，,；;：:\s]+/, '')
  return cleaned && lengthOf(cleaned) <= 30 ? cleaned : ''
}

export function buildDouyinSummary(seoDescription: string | undefined, article: CanonicalArticle): string {
  const preferred = normalize(seoDescription || '')
  const fallback = article.blocks.find((block) => block.kind === 'paragraph' && normalize(block.text))
    || article.blocks.find((block) => 'text' in block && normalize(block.text))
  const source = preferred || (fallback && 'text' in fallback ? normalize(fallback.text) : '')
  if (!source) return ''
  if (lengthOf(source) <= 30) return source

  // SEO 描述往往以“面向某类读者，说明……”开头。直接截取 30 字会得到
  // “智能防”之类的半句话；先去掉受众/写作意图套语，再寻找完整短句或分句。
  const condensed = source
    .replace(/^面向[^，,。！？!?；;]{2,28}[，,]\s*/, '')
    .replace(/^(?:本文|本篇|本文章|文章)?\s*(?:主要)?\s*(?:说明|介绍|解析|讲解|梳理|聚焦|详解)\s*/, '')
  const sentenceCandidates = [condensed, source]
    .flatMap((value) => value.match(/[^。！？!?；;]+[。！？!?；;]?/g) || [])
    .map(withinSummaryLimit)
    .filter(Boolean)
  if (sentenceCandidates.length) return sentenceCandidates[0]

  const clauseCandidates = condensed
    .split(/[，,；;：:]/)
    .map(withinSummaryLimit)
    .filter((value) => lengthOf(value) >= 6)
  if (clauseCandidates.length) return clauseCandidates[0]

  // 长 SEO 无法在限制内形成完整语义时，文章标题通常比生硬截断更准确。
  const title = withinSummaryLimit(normalize(article.title).replace(/\s*[-—|｜]\s*易造防雷\s*$/, ''))
  if (title) return title

  // 最终兜底明确使用省略号，避免把被截断的半句话伪装成完整摘要。
  return `${Array.from(condensed || source).slice(0, 29).join('').replace(/[，,；;：:\s]+$/g, '')}…`
}

function normalizeDouyinArticle(article: CanonicalArticle, title: string): CanonicalArticle {
  const comparable = (value: string) => normalize(value).replace(/[？?！!。:：]+$/g, '')
  const source = [...article.blocks]
  const first = source[0]
  if (first?.kind === 'heading' && comparable(first.text) === comparable(title)) source.shift()
  let anchor = 0
  let imageOrder = 0
  const blocks: CanonicalBlock[] = []
  for (const block of source) {
    if (block.kind === 'divider') continue
    if (block.kind === 'image') { blocks.push({ ...block, order: ++imageOrder, anchor }); continue }
    blocks.push(block); anchor++
  }
  const images = blocks.filter((block): block is Extract<CanonicalBlock, { kind: 'image' }> => block.kind === 'image')
  return { ...article, blocks, images }
}

function fidelity(checks: FidelityCheck[]): FidelityReport {
  const summary = { pass: 0, degraded: 0, unsupported: 0, fail: 0 }
  for (const check of checks) summary[check.status.toLowerCase() as keyof typeof summary]++
  const fidelityVerified = checks.every((check) => !check.required || check.status === 'PASS')
  return {
    schema: 'yizao-html-fidelity-report', version: 1,
    overall: fidelityVerified ? (summary.degraded ? 'DEGRADED' : 'PASS') : 'FAIL',
    fidelityVerified, checks, summary,
  }
}

export class DouyinAdapter extends CodeAdapter {
  readonly meta: PlatformMeta = {
    id: 'douyin', name: '抖音', icon: 'https://www.douyin.com/favicon.ico', homepage: PUBLISH_URL,
    capabilities: ['article', 'draft', 'image_upload', 'long_article'], authCheckMode: 'interactive',
  }
  readonly preprocessConfig = { outputFormat: 'html' as const }
  private tabId: number | null = null

  private async ensureTab(): Promise<number> {
    if (!this.runtime.tabs) throw new Error('当前运行环境不支持抖音页面安全请求')
    const existing = await this.runtime.tabs.query('https://creator.douyin.com/*')
    const usable = existing.filter((tab) => !/login|passport/i.test(String(tab.url || '')))
    const selected = usable.find((tab) => /\/creator-micro\/content\/upload/i.test(String(tab.url || '')) && /[?&]page=article(?:&|$)/i.test(String(tab.url || '')))
      || usable.find((tab) => /\/creator-micro\/content\/upload/i.test(String(tab.url || '')))
      || usable[0]
    if (selected) { this.tabId = selected.id; await this.runtime.tabs.activate?.(selected.id); return selected.id }
    this.tabId = null
    const created = await this.runtime.tabs.create(PUBLISH_URL, true)
    await this.runtime.tabs.waitForLoad(created.id, 45000)
    this.tabId = created.id
    return created.id
  }

  private async pageRun<T, A extends unknown[]>(fn: (...args: A) => T, args: A): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const tabId = await this.ensureTab()
      try { return await this.runtime.tabs!.executeScript<T, A>(tabId, fn, args) }
      catch (error) {
        const message = String((error as Error)?.message || '')
        if (attempt === 0 && /No tab with id|cannot be edited|Frame with ID .* was removed/i.test(message)) {
          this.tabId = null; await new Promise((resolve) => setTimeout(resolve, 350)); continue
        }
        throw error
      }
    }
    throw new Error('抖音创作页面不可用；请检查页面是否已打开且已登录')
  }

  async checkAuth(): Promise<AuthResult> {
    try {
      const cookieDomains = ['douyin.com', 'creator.douyin.com']
      const cookieNames = ['sessionid', 'sessionid_ss', 'sid_guard', 'uid_tt', 'uid_tt_ss']
      let sessionCookie = ''
      for (const domain of cookieDomains) {
        for (const name of cookieNames) {
          sessionCookie = (await this.runtime.getCookie?.(domain, name)) || ''
          if (sessionCookie) break
        }
        if (sessionCookie) break
      }
      const page = await this.pageRun(async () => {
        let strongCreatorDom = false
        let hasLoginForm = false
        for (let i = 0; i < 20; i++) {
          const text = String(document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 5000)
          hasLoginForm = Boolean(document.querySelector('input[type="password"], input[placeholder*="手机号"], input[placeholder*="验证码"]'))
          strongCreatorDom = Boolean(document.querySelector('a[href*="/creator-micro/content"], a[href*="/content/manage"], [class*="upload"] input[type="file"]'))
            || /发布视频|发布图文|发布全景视频|发布文章|内容管理|作品管理/.test(text)
          if (strongCreatorDom || hasLoginForm) break
          await new Promise((resolve) => setTimeout(resolve, 500))
        }
        const html = document.documentElement.innerHTML
        return {
          title: document.title.slice(0, 60), url: location.href.slice(0, 180),
          nickname: (html.match(/"nickname"\s*:\s*"([^"]{1,40})"/) || [])[1] || '',
          strongCreatorDom, hasLoginForm,
        }
      }, [])
      if (/login|passport/i.test(page.url) || (page.hasLoginForm && !page.strongCreatorDom)) {
        return { isAuthenticated: false, error: '抖音页面跳转到了登录页；请先登录创作者中心' }
      }
      if (!sessionCookie && !page.strongCreatorDom) {
        return { isAuthenticated: false, error: `未检测到抖音登录凭证或创作者工作台结构（页面：${page.title} @ ${page.url}）` }
      }
      return { isAuthenticated: true, userId: page.nickname || 'douyin-current-session', username: page.nickname || '当前 Chrome 抖音会话' }
    } catch (error) { return { isAuthenticated: false, error: (error as Error).message } }
  }

  async publish(_article: Article, _options?: PublishOptions): Promise<SyncResult> {
    throw new Error('抖音公开发布已禁用；仅允许通过受保护的 saveDraft 工作流保存文章草稿')
  }

  async saveDraft(article: Article, options?: PublishOptions): Promise<SyncResult> {
    try {
      const authorization = options?.draftAuthorization
      if (authorization?.action !== 'saveDraft' || authorization.platform !== 'douyin'
        || !/^tsk_[0-9]+_[0-9a-f]{8}$/.test(authorization.taskId || '')
        || !/^snap-[0-9a-f]{24}$/.test(authorization.snapshotId || '')) {
        throw new Error('抖音 saveDraft 缺少本地服务签发的任务/快照授权')
      }
      if (Array.from(article.title || '').length < 2 || Array.from(article.title || '').length > 30) throw new Error('抖音文章标题需为 2～30 个字符')
      await options?.onDraftStage?.('running')
      const canonical = normalizeDouyinArticle(parseCanonicalArticle(article.html || '', article.title), article.title)
      if (!canonical.blocks.length) throw new Error('发布包 HTML 没有可保存的正文块')
      assertCaptionPolicy(canonical)
      const html = renderCanonicalArticle(canonical)
      const docxBase64 = await buildDouyinImportDocx(canonical)
      const summary = buildDouyinSummary(article.summary, canonical)
      if (!summary) throw new Error('发布包没有 SEO 描述或可用于摘要的正文首段')
      const expectedText = canonical.blocks.filter((block) => block.kind !== 'image' && block.kind !== 'divider')
        .map((block) => 'text' in block ? block.text : '').join(' ')
      // 抖音文章页会在富文本导入时自行抓取/接管图片；仍按统一任务状态机
      // 先进入 uploading，再进入 filling，避免服务端出现 running -> filling 跳级。
      await options?.onDraftStage?.('uploading')
      await options?.onDraftStage?.('filling')

      const pageResult = await this.pageRun(async (input) => {
        const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
        const clean = (value: string) => String(value || '').replace(/[\s\u200B-\u200D\uFEFF]+/g, ' ').trim()
        const visible = (element: Element | null): element is HTMLElement => {
          if (!(element instanceof HTMLElement)) return false
          const rect = element.getBoundingClientRect(); const style = getComputedStyle(element)
          return rect.width > 20 && rect.height > 10 && style.display !== 'none' && style.visibility !== 'hidden'
        }
        const exactAction = (labels: string[]) => Array.from(document.querySelectorAll<HTMLElement>('button, [role="button"], a, div, span'))
          .filter((element) => visible(element) && labels.includes(clean(element.innerText || element.textContent)))
          .sort((left, right) => left.childElementCount - right.childElementCount)[0] || null
        const clickAction = (labels: string[]) => {
          const textNode = exactAction(labels)
          if (!textNode) return false
          // 抖音按钮文案常在 span 中，真正的 React onClick 绑定在外层。
          // 始终点击最近的可交互祖先，避免只点中文字节点但页面无响应。
          const target = textNode.closest<HTMLElement>('button, a, [role="button"], [tabindex]') || textNode
          target.scrollIntoView({ block: 'center', inline: 'center' })
          target.click()
          return true
        }
        const clickArticleEntry = () => {
          const candidates = Array.from(document.querySelectorAll<HTMLElement>('button, [role="tab"], [role="button"], a, div, span'))
            .filter((element) => visible(element) && clean(element.innerText || element.textContent) === '发布文章')
            .sort((left, right) => left.childElementCount - right.childElementCount)
          for (const candidate of candidates) {
            // 只允许点击与“发布视频/发布图文”同组的导航标签。编辑器底部若出现
            // 同名提交按钮，不具备这个上下文，因此绝不会被这里命中。
            let context: HTMLElement | null = candidate.parentElement
            let isCreationTab = false
            for (let depth = 0; context && depth < 6; depth++, context = context.parentElement) {
              const contextText = clean(context.innerText || context.textContent || '')
              if (contextText.includes('发布视频') && contextText.includes('发布图文') && contextText.includes('发布文章')) {
                isCreationTab = true
                break
              }
            }
            if (!isCreationTab) continue
            const target = candidate.closest<HTMLElement>('button, a, [role="tab"], [role="button"], [tabindex]') || candidate
            target.scrollIntoView({ block: 'center', inline: 'center' })
            target.click()
            return true
          }
          return false
        }
        const findVisible = (selectors: string[]) => selectors.map((selector) => document.querySelector(selector)).find(visible) as HTMLElement | undefined || null
        const titleSelectors = ['textarea[placeholder*="标题"]', 'input[placeholder*="标题"]', '[contenteditable="true"][data-placeholder*="标题"]', '[contenteditable="true"][placeholder*="标题"]']
        const bodySelectors = ['.ProseMirror[contenteditable="true"]', '.tiptap[contenteditable="true"]', '[contenteditable="true"][data-placeholder*="正文"]', '[contenteditable="true"][placeholder*="正文"]', '[contenteditable="true"][aria-label*="正文"]']
        const summarySelectors = ['textarea[placeholder*="摘要"]', 'input[placeholder*="摘要"]', 'textarea[placeholder*="最多不超过30"]', '[contenteditable="true"][data-placeholder*="摘要"]']
        try {
          if (location.hostname !== 'creator.douyin.com' || /login|passport/i.test(location.href)) return { ok: false, error: '请先登录抖音创作者中心' }
          // 创作者中心有时停在“发布视频/发布图文”默认入口。只有当“一键导入”
          // 尚未出现时，才点击发布类型导航中的“发布文章”；这不是最终发布动作。
          if (!exactAction(['一键导入'])) {
            if (!clickArticleEntry()) return { ok: false, error: '没有找到抖音创作页顶部的“发布文章”入口，已停止导入' }
            let articleEntryReady = false
            for (let attempt = 0; attempt < 60; attempt++) {
              if (exactAction(['一键导入'])) { articleEntryReady = true; break }
              await sleep(200)
            }
            if (!articleEntryReady) return { ok: false, error: '已点击“发布文章”，但 12 秒内没有出现“一键导入”按钮' }
          }
          // 使用抖音官方 DOCX 导入通道；官方页面负责接管文档内嵌图片。
          let importInput: HTMLInputElement | null = null
          for (let attempt = 0; attempt < 40; attempt++) {
            importInput = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="file"]'))
              .find((element) => /docx|\.doc/i.test(element.accept || '') || clean(element.closest('div')?.innerText || '').includes('导入文章')) || null
            if (importInput) break
            if (attempt % 6 === 0) clickAction(['一键导入'])
            await sleep(250)
          }
          if (!importInput) return { ok: false, error: '已打开抖音文章页，但没有找到官方“一键导入”的 DOCX 上传控件' }
          const binary = atob(input.docxBase64)
          const bytes = new Uint8Array(binary.length)
          for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
          const transfer = new DataTransfer()
          transfer.items.add(new File([bytes], input.filename, { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }))
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'files')?.set?.call(importInput, transfer.files)
          importInput.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
          importInput.dispatchEvent(new Event('change', { bubbles: true, composed: true }))

          let titleElement: HTMLElement | null = null
          let bodyElement: HTMLElement | null = null
          for (let attempt = 0; attempt < 240; attempt++) {
            titleElement = findVisible(titleSelectors)
            bodyElement = findVisible(bodySelectors)
            if (!bodyElement) {
              bodyElement = Array.from(document.querySelectorAll<HTMLElement>('[contenteditable="true"]'))
                .filter((element) => visible(element) && element !== titleElement)
                .sort((a, b) => {
                  const ar = a.getBoundingClientRect(); const br = b.getBoundingClientRect()
                  return (br.width * br.height) - (ar.width * ar.height)
                })[0] || null
            }
            if (titleElement && bodyElement) break
            await sleep(250)
          }
          if (!titleElement || !bodyElement) return { ok: false, error: `DOCX 已交给抖音官方导入控件，但 60 秒内没有进入文章编辑器（页面：${clean(document.body?.innerText || '').slice(0, 240)}）` }
          const dispatch = (element: HTMLElement, inputType: string) => {
            try { element.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType })) }
            catch { element.dispatchEvent(new Event('input', { bubbles: true, composed: true })) }
            element.dispatchEvent(new Event('change', { bubbles: true, composed: true }))
          }
          const replace = (element: HTMLElement, value: string, isHtml: boolean) => {
            element.focus()
            if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
              const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
              Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(element, value)
              dispatch(element, 'insertText'); return
            }
            const selection = getSelection(); const range = document.createRange()
            range.selectNodeContents(element); selection?.removeAllRanges(); selection?.addRange(range)
            let inserted = false
            try { inserted = document.execCommand(isHtml ? 'insertHTML' : 'insertText', false, value) } catch { /* fallback */ }
            if (!inserted) { if (isHtml) element.innerHTML = value; else element.textContent = value }
            dispatch(element, isHtml ? 'insertFromPaste' : 'insertText')
          }
          replace(titleElement, input.title, false)
          if (!clean(bodyElement.innerText || bodyElement.textContent || '')) replace(bodyElement, input.html, true)

          const isCaptionEditor = (element: Element | null): element is HTMLElement => {
            if (!(element instanceof HTMLElement) || element === titleElement || element === bodyElement) return false
            const hint = `${element.getAttribute('placeholder') || ''} ${element.getAttribute('data-placeholder') || ''} ${element.getAttribute('aria-label') || ''}`
            return /图片描述|最多30字/.test(hint) || (element.isContentEditable && /图片描述|最多30字/.test(clean(element.innerText || element.textContent || '')))
          }
          const directCaptionEditors = () => Array.from(document.querySelectorAll<HTMLElement>('textarea, input, [contenteditable="true"]'))
            .filter((element) => isCaptionEditor(element) && visible(element))
          const captionEditors: HTMLElement[] = directCaptionEditors()
          if (captionEditors.length < input.captions.length) {
            const placeholders = Array.from(document.querySelectorAll<HTMLElement>('div, span, p'))
              .filter((element) => visible(element) && /点击输入图片描述/.test(clean(element.innerText || element.textContent || '')))
              .sort((left, right) => left.childElementCount - right.childElementCount)
            for (const placeholder of placeholders) {
              if (captionEditors.length >= input.captions.length) break
              placeholder.scrollIntoView({ block: 'center' })
              placeholder.click()
              await sleep(150)
              const active = document.activeElement
              const candidate = isCaptionEditor(active) ? active
                : Array.from(placeholder.parentElement?.querySelectorAll<HTMLElement>('textarea, input, [contenteditable="true"]') || []).find(isCaptionEditor)
              if (candidate && !captionEditors.includes(candidate)) captionEditors.push(candidate)
              for (const editor of directCaptionEditors()) if (!captionEditors.includes(editor)) captionEditors.push(editor)
            }
          }
          if (captionEditors.length !== input.captions.length) {
            return { ok: false, error: `文章已导入，但只找到 ${captionEditors.length}/${input.captions.length} 个抖音图片描述框，已停止验收` }
          }
          for (let index = 0; index < input.captions.length; index++) {
            replace(captionEditors[index], input.captions[index], false)
            captionEditors[index].blur()
          }
          const captions = captionEditors.map((element) => clean(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
            ? element.value : element.innerText || element.textContent || ''))
          if (JSON.stringify(captions) !== JSON.stringify(input.captions.map(clean))) {
            return { ok: false, error: `抖音图片描述回读不一致（期望 ${input.captions.length} 条，回读 ${captions.filter(Boolean).length} 条）` }
          }

          let summaryElement: HTMLElement | null = null
          for (let attempt = 0; attempt < 40; attempt++) {
            summaryElement = findVisible(summarySelectors)
            if (summaryElement) break
            await sleep(250)
          }
          if (!summaryElement) return { ok: false, error: '文章已导入，但没有找到抖音“文章摘要”输入框，已停止验收' }
          replace(summaryElement, input.summary, false)
          summaryElement.blur()
          bodyElement.blur(); titleElement.blur()

          let savedText = ''
          for (let attempt = 0; attempt < 60; attempt++) {
            const currentTitle = clean(titleElement instanceof HTMLInputElement || titleElement instanceof HTMLTextAreaElement ? titleElement.value : titleElement.innerText || titleElement.textContent || '')
            const currentBody = clean(bodyElement.innerText || bodyElement.textContent || '')
            const currentImages = bodyElement.querySelectorAll('img').length
            savedText = clean(document.body?.innerText || '').match(/(?:草稿)?(?:已自动)?保存(?:成功)?|已存入草稿|已保存/g)?.at(-1) || ''
            if (currentTitle === clean(input.title) && currentBody.includes(clean(input.expectedText).slice(0, Math.min(80, clean(input.expectedText).length)))
              && currentImages >= input.imageCount && savedText) break
            await sleep(500)
          }
          const title = clean(titleElement instanceof HTMLInputElement || titleElement instanceof HTMLTextAreaElement ? titleElement.value : titleElement.innerText || titleElement.textContent || '')
          const bodyText = clean(bodyElement.innerText || bodyElement.textContent || '')
          const imageCount = bodyElement.querySelectorAll('img').length
          const summary = clean(summaryElement instanceof HTMLInputElement || summaryElement instanceof HTMLTextAreaElement
            ? summaryElement.value : summaryElement.innerText || summaryElement.textContent || '')
          if (title !== clean(input.title)) return { ok: false, error: '抖音文章标题写入后回读不一致' }
          if (summary !== clean(input.summary)) return { ok: false, error: `抖音文章摘要写入后回读不一致（期望 ${clean(input.summary).length} 字，回读 ${summary.length} 字）` }
          if (!bodyText.includes(clean(input.expectedText).slice(0, Math.min(80, clean(input.expectedText).length)))) return { ok: false, error: '抖音文章正文写入后回读不一致' }
          if (imageCount !== input.imageCount) return { ok: false, error: `抖音文章图片回读为 ${imageCount}/${input.imageCount}，已停止验收` }
          if (!savedText) return { ok: false, error: '文章已导入编辑器，但页面尚未显示“已保存”状态；请不要重复点击，等待页面自动保存后再重试' }

          const idFrom = (value: string) => value.match(/(?:draft_id|article_id|item_id|content_id)["'=:\s%]+([0-9]{5,})/i)?.[1] || ''
          let draftId = idFrom(location.href)
          if (!draftId) draftId = idFrom(Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]')).map((a) => a.href).join(' '))
          if (!draftId) draftId = idFrom(document.documentElement.innerHTML)
          if (!draftId) {
            for (let index = 0; index < localStorage.length; index++) {
              const key = localStorage.key(index) || ''
              if (/draft|article|content/i.test(key)) draftId = idFrom(`${key}:${localStorage.getItem(key) || ''}`)
              if (draftId) break
            }
          }
          if (!draftId) return { ok: false, error: '文章已导入并显示已保存，但未能回读抖音草稿 ID；为避免误报成功，已停在编辑器供人工检查' }
          return { ok: true, draftId, url: location.href, title, html: bodyElement.innerHTML, bodyText, imageCount, savedText, summary, captions }
        } catch (error) { return { ok: false, error: String((error as Error)?.message || error) } }
      }, [{
        title: article.title, html, summary, expectedText, imageCount: canonical.images.length,
        captions: canonical.images.map((image) => Array.from(image.captionCandidate).slice(0, 30).join('')), docxBase64,
        filename: `${article.title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 80) || '抖音文章'}.docx`,
      }]) as DouyinPageResult

      if (!pageResult.ok || !pageResult.draftId || !pageResult.url) throw new Error(pageResult.error || '抖音文章草稿保存失败')
      await options?.onDraftStage?.('saving_draft')
      const structural = validateCanonicalFidelity(canonical, pageResult.html || '', pageResult.title || '')
      const structuralByKey = new Map(structural.checks.map((check) => [check.key, check]))
      const pass = (key: string) => structuralByKey.get(key)?.status === 'PASS' ? 'PASS' as const : 'FAIL' as const
      const checks: FidelityCheck[] = [
        { key: 'title', status: normalize(pageResult.title || '') === normalize(article.title) ? 'PASS' : 'FAIL', required: true, detail: '抖音文章编辑器回读标题一致' },
        { key: 'summary', status: normalize(pageResult.summary || '') === summary ? 'PASS' : 'FAIL', required: true, detail: '文章摘要优先取 SEO 描述、最多 30 字，并已回读一致' },
        { key: 'main-block-order', status: pass('main-block-order'), required: true, detail: '编辑器回读正文主块与顺序一致' },
        { key: 'inline-emphasis', status: pass('inline-emphasis'), required: true, detail: '编辑器回读行内强调语义' },
        { key: 'image-count', status: pageResult.imageCount === canonical.images.length ? 'PASS' : 'FAIL', required: true, detail: `源 ${canonical.images.length} / 回读 ${pageResult.imageCount || 0}` },
        { key: 'image-order', status: JSON.stringify(pageResult.captions || []) === JSON.stringify(canonical.images.map((image) => Array.from(image.captionCandidate).slice(0, 30).join(''))) ? 'PASS' : 'FAIL', required: true, detail: '按图片顺序回读抖音图片描述一致' },
        { key: 'image-anchor', status: pass('image-anchor'), required: true, detail: '图片锚点回读一致' },
        { key: 'caption-equals-html-alt', status: JSON.stringify(pageResult.captions || []) === JSON.stringify(canonical.images.map((image) => Array.from(image.captionCandidate).slice(0, 30).join(''))) ? 'PASS' : 'FAIL', required: true, detail: '抖音图片描述由 HTML ALT 生成（平台上限 30 字）' },
        { key: 'trusted-draft-url', status: /^https:\/\/creator\.douyin\.com\//.test(pageResult.url) ? 'PASS' : 'FAIL', required: true, detail: '仅接受抖音 HTTPS 创作者中心草稿地址' },
        { key: 'draft-only', status: 'PASS', required: true, detail: '仅填写文章并等待页面自动保存；未点击任何发布按钮' },
        { key: 'read-back-verified', status: pageResult.savedText ? 'PASS' : 'FAIL', required: true, detail: `页面保存状态：${pageResult.savedText || '未检测到'}` },
      ]
      const fidelityReport = fidelity(checks)
      if (!fidelityReport.fidelityVerified) throw new Error('抖音文章已导入，但保存后内容保真回读未全部通过；请在编辑器中人工检查')
      return this.createResult(true, {
        postId: pageResult.draftId, postUrl: pageResult.url, draftOnly: true,
        readBackVerified: true, fidelityVerified: true, fidelityReport,
      })
    } catch (error) {
      logger.error('Guarded Douyin draft save failed', error)
      return this.createResult(false, { error: (error as Error).message })
    }
  }
}
