/**
 * 小红书受保护图文草稿适配器。
 *
 * 仅在当前 Chrome 的 creator.xiaohongshu.com 页面中上传图片、填写标题和
 * 正文，并调用页面自身的“暂存离开”能力。保存后从页面自己的 IndexedDB
 * 回读标题、正文与图片数量；publish() 永久拒绝公开发布。
 */
import { CodeAdapter } from '../code-adapter'
import type { Article, AuthResult, PlatformMeta, SyncResult } from '../../types'
import type { PublishOptions } from '../types'
import type { FidelityCheck, FidelityReport } from '../../article/canonical'
import { assertCaptionPolicy, parseCanonicalArticle } from '../../article/canonical'
import { createLogger } from '../../lib/logger'

const logger = createLogger('Xiaohongshu')
const EDITOR_URL = 'https://creator.xiaohongshu.com/publish/publish?from=menu_left&target=image'
const MAX_TITLE_LENGTH = 20
const MAX_BODY_LENGTH = 1000
const MAX_IMAGES = 9

type PageArticle = { title: string; body: string; images: Array<{ source: string; name: string }> }
type PageResult = {
  ok: boolean
  authenticated?: boolean
  draftId?: string
  title?: string
  body?: string
  imageCount?: number
  error?: string
}

function normalize(value: string): string { return value.replace(/\s+/g, ' ').trim() }

function plainBody(article: ReturnType<typeof parseCanonicalArticle>): string {
  return article.blocks.map((block) => {
    if (block.kind === 'divider') return ''
    if (block.kind === 'image') return `图片${block.order}：${block.alt}`
    return block.text
  }).filter(Boolean).join('\n\n')
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

export class XiaohongshuAdapter extends CodeAdapter {
  readonly meta: PlatformMeta = {
    id: 'xiaohongshu', name: '小红书', icon: 'https://creator.xiaohongshu.com/favicon.ico', homepage: EDITOR_URL,
    capabilities: ['article', 'draft', 'image_upload'],
  }
  readonly preprocessConfig = {
    outputFormat: 'html' as const, removeIframes: true, removeComments: true,
    removeSpecialTags: true, processLazyImages: true, removeEmptyImages: true,
    removeSrcset: true, removeSizes: true,
  }
  private editorTabId: number | null = null

  async checkAuth(): Promise<AuthResult> {
    try {
      const tabId = await this.ensureEditorTab()
      const result = await this.runtime.tabs!.executeScript<PageResult, []>(tabId, () => {
        const authenticated = location.hostname === 'creator.xiaohongshu.com'
          && !location.pathname.toLowerCase().includes('login')
          && Boolean(document.querySelector('input[type="file"], xhs-publish-btn, [contenteditable="true"]'))
        return { ok: authenticated, authenticated }
      }, [])
      return result.authenticated
        ? { isAuthenticated: true, userId: 'xiaohongshu-current-session', username: '当前 Chrome 小红书会话' }
        : { isAuthenticated: false, error: '请先在当前 Chrome 登录小红书创作服务平台' }
    } catch (error) { return { isAuthenticated: false, error: (error as Error).message } }
  }

  async publish(_article: Article, _options?: PublishOptions): Promise<SyncResult> {
    throw new Error('小红书公开发布已禁用；仅允许通过受保护的 saveDraft 工作流暂存图文草稿')
  }

  async saveDraft(article: Article, options?: PublishOptions): Promise<SyncResult> {
    try {
      const authorization = options?.draftAuthorization
      if (authorization?.action !== 'saveDraft' || authorization.platform !== 'xiaohongshu'
        || !/^tsk_[0-9]+_[0-9a-f]{8}$/.test(authorization.taskId || '')
        || !/^snap-[0-9a-f]{24}$/.test(authorization.snapshotId || '')) {
        throw new Error('小红书 saveDraft 缺少本地服务签发的任务/快照授权')
      }
      await options?.onDraftStage?.('running')
      const canonical = parseCanonicalArticle(article.html || '', article.title)
      if (!canonical.blocks.length) throw new Error('发布包 HTML 没有可保存的正文块')
      assertCaptionPolicy(canonical)
      if (!canonical.images.length) throw new Error('小红书图文草稿至少需要 1 张图片')
      if (canonical.images.length > MAX_IMAGES) throw new Error(`小红书图文草稿最多允许 ${MAX_IMAGES} 张图片`)
      if (Array.from(article.title).length > MAX_TITLE_LENGTH) throw new Error(`小红书标题超过 ${MAX_TITLE_LENGTH} 字，已阻止保存；不会静默截断`)
      const body = plainBody(canonical)
      if (Array.from(body).length > MAX_BODY_LENGTH) throw new Error(`小红书正文超过 ${MAX_BODY_LENGTH} 字，已阻止保存；不会静默截断`)

      const pageArticle: PageArticle = {
        title: article.title,
        body,
        images: canonical.images.map((image) => ({ source: image.source, name: `image-${image.order}.jpg` })),
      }
      await options?.onDraftStage?.('uploading')
      const tabId = await this.ensureEditorTab()
      await options?.onDraftStage?.('filling')
      // 页面填写与暂存目前在同一个 MAIN-world 原子步骤内完成。为避免任何
      // 不确定失败被当成“尚未保存”而自动重试，进入页面步骤前先持久化
      // saving_draft；这是有意的 fail-closed 处理。
      await options?.onDraftStage?.('saving_draft')
      const pageResult = await this.runtime.tabs!.executeScript<PageResult, [PageArticle]>(tabId, async (input) => {
        const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
        const visible = (element: Element | null): element is HTMLElement => {
          if (!(element instanceof HTMLElement) || element.offsetParent === null) return false
          const rect = element.getBoundingClientRect()
          return rect.width > 0 && rect.height > 0
        }
        const normalizeText = (value: unknown) => String(value || '').replace(/\s+/g, ' ').trim()
        const titleSelectors = [
          '[contenteditable="true"][placeholder*="标题"]', '[contenteditable="true"][placeholder*="赞"]',
          'input[placeholder*="标题"]', 'input[maxlength="20"]', '.title-input input',
        ]
        const bodySelectors = [
          '[contenteditable="true"][class*="content"]', '[contenteditable="true"][class*="editor"]',
          '[contenteditable="true"][placeholder*="描述"]', '[contenteditable="true"][placeholder*="正文"]',
          '[contenteditable="true"][placeholder*="内容"]',
        ]
        const findVisible = (selectors: string[]) => {
          for (const selector of selectors) {
            const element = Array.from(document.querySelectorAll(selector)).find(visible)
            if (element) return element as HTMLElement
          }
          return null
        }
        const readDrafts = async () => {
          return await new Promise<Array<{ key: IDBValidKey; row: any }>>((resolve, reject) => {
            const open = indexedDB.open('draft-database-v1')
            open.onerror = () => reject(open.error || new Error('无法打开小红书草稿库'))
            open.onsuccess = () => {
              const db = open.result
              if (!db.objectStoreNames.contains('image-draft')) { db.close(); resolve([]); return }
              const transaction = db.transaction('image-draft', 'readonly')
              const store = transaction.objectStore('image-draft')
              const rows = store.getAll()
              const keys = store.getAllKeys()
              transaction.oncomplete = () => {
                const values = (rows.result || []).map((row, index) => ({ key: (keys.result || [])[index] ?? index, row }))
                db.close(); resolve(values)
              }
              transaction.onerror = () => { db.close(); reject(transaction.error || new Error('读取小红书草稿库失败')) }
            }
          })
        }
        const draftShape = (entry: { key: IDBValidKey; row: any }) => {
          const content = entry.row?.content || {}
          const draft = content?.draftStore || {}
          const live = content?.contextStore?.liveContext || {}
          const title = normalizeText(draft.title || live.title || entry.row?.title || entry.row?.noteTitle)
          const body = normalizeText(content?.editorContent?.text || content?.editorContent?.plainText || '')
          const imageCount = Number(draft?.imgList?.length || content?.noteImageConfig?.items?.length
            || content?.noteImageConfig?.imageList?.length || entry.row?.images?.length || entry.row?.imageList?.length || 0)
          const key = typeof entry.key === 'string' ? `s:${entry.key}` : typeof entry.key === 'number' ? `n:${entry.key}` : `j:${encodeURIComponent(JSON.stringify(entry.key))}`
          return { key, title, body, imageCount }
        }
        try {
          if (location.hostname !== 'creator.xiaohongshu.com' || location.pathname.toLowerCase().includes('login')) {
            return { ok: false, error: '请先登录小红书创作服务平台' }
          }
          const beforeKeys = new Set((await readDrafts()).map((entry) => draftShape(entry).key))
          let fileInput: HTMLInputElement | null = null
          for (let attempt = 0; attempt < 40 && !fileInput; attempt++) {
            fileInput = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="file"]')).find((element) => {
              const accept = element.accept || ''
              return accept.includes('image') || /\.(jpe?g|png|gif|webp)/i.test(accept)
            }) || null
            if (!fileInput) await sleep(250)
          }
          if (!fileInput) return { ok: false, error: '小红书图文上传入口未出现，请确认当前为“上传图文”页面' }
          const transfer = new DataTransfer()
          for (let index = 0; index < input.images.length; index++) {
            const response = await fetch(input.images[index].source)
            if (!response.ok) return { ok: false, error: `第 ${index + 1} 张图片读取失败` }
            const blob = await response.blob()
            if (blob.size > 20 * 1024 * 1024) return { ok: false, error: `第 ${index + 1} 张图片超过 20MB` }
            transfer.items.add(new File([blob], input.images[index].name, { type: blob.type || 'image/jpeg' }))
          }
          Object.defineProperty(fileInput, 'files', { configurable: true, value: transfer.files })
          fileInput.dispatchEvent(new Event('input', { bubbles: true }))
          fileInput.dispatchEvent(new Event('change', { bubbles: true }))

          let titleElement: HTMLElement | null = null
          let bodyElement: HTMLElement | null = null
          for (let attempt = 0; attempt < 60; attempt++) {
            titleElement = findVisible(titleSelectors)
            bodyElement = findVisible(bodySelectors)
            const loading = document.querySelector('[class*="uploading"], [class*="upload"][class*="progress"]')
            if (titleElement && bodyElement && !loading) break
            await sleep(500)
          }
          if (!titleElement || !bodyElement) return { ok: false, error: '图片上传后没有找到小红书标题或正文输入区' }
          const fill = (element: HTMLElement, value: string) => {
            element.focus()
            if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
              const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
              Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(element, value)
              element.dispatchEvent(new InputEvent('input', { bubbles: true, data: value, inputType: 'insertText' }))
              element.dispatchEvent(new Event('change', { bubbles: true }))
              element.blur()
              return normalizeText(element.value) === normalizeText(value)
            }
            const selection = getSelection()
            const range = document.createRange()
            range.selectNodeContents(element); selection?.removeAllRanges(); selection?.addRange(range)
            document.execCommand('delete', false)
            const inserted = document.execCommand('insertText', false, value)
            if (!inserted) element.textContent = value
            element.dispatchEvent(new InputEvent('input', { bubbles: true, data: value, inputType: 'insertText' }))
            element.dispatchEvent(new Event('change', { bubbles: true }))
            element.blur()
            return normalizeText(element.innerText || element.textContent) === normalizeText(value)
          }
          if (!fill(titleElement, input.title)) return { ok: false, error: '小红书标题填写后页面值不一致，已停止暂存' }
          if (!fill(bodyElement, input.body)) return { ok: false, error: '小红书正文填写后页面值不一致，已停止暂存' }

          const hosts = Array.from(document.querySelectorAll('xhs-publish-btn')).filter(visible) as Array<HTMLElement & Record<string, unknown>>
          let invoked = false
          for (const host of hosts) {
            for (const name of ['_onSave', '_onSaveDraft', '_onDraft']) {
              const method = host[name]
              if (typeof method !== 'function') continue
              try { (method as () => void).call(host); invoked = true; break } catch { /* try next official page callback */ }
            }
            if (invoked) break
          }
          if (!invoked) {
            const button = Array.from(document.querySelectorAll('button, [role="button"]')).find((element) => {
              const text = normalizeText((element as HTMLElement).innerText || element.textContent)
              return visible(element) && ['暂存离开', '存草稿', '保存草稿'].some((label) => text.includes(label))
            }) as HTMLButtonElement | null
            if (button && !button.disabled) { button.click(); invoked = true }
          }
          if (!invoked) return { ok: false, error: '小红书页面没有提供可用的“暂存离开”入口；公开发布未执行' }

          for (let attempt = 0; attempt < 40; attempt++) {
            await sleep(500)
            const drafts = (await readDrafts()).map(draftShape)
            const matched = drafts.find((draft) => !beforeKeys.has(draft.key)
              && draft.title === normalizeText(input.title)
              && draft.body === normalizeText(input.body)
              && draft.imageCount === input.images.length)
            if (matched) return { ok: true, draftId: matched.key, title: matched.title, body: matched.body, imageCount: matched.imageCount }
          }
          return { ok: false, error: '小红书页面执行了暂存，但未能从本地草稿库回读匹配的标题、正文和图片数量' }
        } catch (error) { return { ok: false, error: String((error as Error)?.message || error) } }
      }, [pageArticle])
      if (!pageResult.ok || !pageResult.draftId) throw new Error(pageResult.error || '小红书草稿暂存失败')
      const checks: FidelityCheck[] = [
        { key: 'title', status: normalize(pageResult.title || '') === normalize(article.title) ? 'PASS' : 'FAIL', required: true, detail: 'IndexedDB 回读标题一致' },
        { key: 'body-text', status: normalize(pageResult.body || '') === normalize(body) ? 'PASS' : 'FAIL', required: true, detail: 'IndexedDB 回读正文与图片说明文本一致' },
        { key: 'image-count', status: pageResult.imageCount === canonical.images.length ? 'PASS' : 'FAIL', required: true, detail: `源 ${canonical.images.length} / 回读 ${pageResult.imageCount || 0}` },
        { key: 'image-order', status: 'UNSUPPORTED', required: false, detail: '小红书本地草稿库未提供稳定的源图片顺序指纹，需人工检查' },
        { key: 'image-anchor', status: 'UNSUPPORTED', required: false, detail: '小红书图文笔记不保留 HTML 正文内图片锚点' },
        { key: 'draft-indexeddb', status: 'PASS', required: true, detail: '已从 creator.xiaohongshu.com 自有 image-draft 草稿库回读' },
        { key: 'trusted-draft-url', status: 'PASS', required: true, detail: '小红书 HTTPS 创作中心图文编辑地址' },
        { key: 'draft-only', status: 'PASS', required: true, detail: '仅调用暂存回调；未调用发布回调' },
        { key: 'read-back-verified', status: 'PASS', required: true, detail: '草稿标题、正文与图片数量已回读核对' },
      ]
      const fidelityReport = fidelity(checks)
      return this.createResult(fidelityReport.fidelityVerified, {
        postId: pageResult.draftId, postUrl: EDITOR_URL, draftOnly: true, readBackVerified: true,
        fidelityVerified: fidelityReport.fidelityVerified, fidelityReport,
      })
    } catch (error) {
      logger.error('Guarded draft save failed', error)
      return this.createResult(false, { error: (error as Error).message })
    }
  }

  private async ensureEditorTab(): Promise<number> {
    if (!this.runtime.tabs) throw new Error('当前运行环境不支持小红书页面安全请求')
    if (this.editorTabId !== null) return this.editorTabId
    const existing = await this.runtime.tabs.query('https://creator.xiaohongshu.com/publish/publish*')
    if (existing[0]) { this.editorTabId = existing[0].id; return existing[0].id }
    const created = await this.runtime.tabs.create(EDITOR_URL, false)
    await this.runtime.tabs.waitForLoad(created.id, 45000)
    this.editorTabId = created.id
    return created.id
  }
}
