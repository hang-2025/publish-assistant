/**
 * 头条号受保护草稿适配器。
 *
 * 头条当前编辑器会在页面 MAIN world 为 /mp/agw/article/publish
 * 补充安全参数。因此草稿请求只在当前 Chrome 的头条编辑页中执行；扩展不读取、
 * 复制或保存 Cookie/Profile。官方编辑器约定 save=0 为草稿，save=1 为发布，
 * 本适配器固定使用字符串 "0"，且 publish() 始终拒绝。
 */
import { CodeAdapter, type ImageUploadResult } from '../code-adapter'
import type { Article, AuthResult, SyncResult, PlatformMeta } from '../../types'
import type { PublishOptions } from '../types'
import { createLogger } from '../../lib/logger'
import {
  assertCaptionPolicy,
  parseCanonicalArticle,
  renderCanonicalArticle,
  validateCanonicalFidelity,
} from '../../article/canonical'

const logger = createLogger('Toutiao')
const EDITOR_URL = 'https://mp.toutiao.com/profile_v4/graphic/publish'

type PageRequest = {
  url: string
  method: 'GET' | 'POST' | 'HEAD'
  headers?: Record<string, string>
  form?: Record<string, string>
  imageSource?: string
}

type PageResponse = { ok: boolean; status: number; text: string; securityToken?: string }

type ToutiaoArticleDefaults = {
  mediaId: string
  articleAdType: string
  publishAb: string
}

type EditorFillResult = {
  titleFilled: boolean
  bodyFilled: boolean
  titleKind: string
  bodyKind: string
}

function parseJson(text: string): any {
  const value = JSON.parse(text)
  return typeof value === 'string' ? JSON.parse(value) : value
}

function normalizeImageUrl(value: string): string {
  if (value.startsWith('//')) return `https:${value}`
  if (value.startsWith('/')) return `https://p1.toutiaoimg.com${value}`
  return value
}

const IMAGE_URL_KEYS = [
  'origin_image_url', 'originImageUrl', 'image_url', 'imageUrl', 'url',
  'download_url', 'downloadUrl', 'display_url', 'displayUrl', 'main_url', 'mainUrl',
]
const IMAGE_URI_KEYS = [
  'origin_image_uri', 'originImageUri', 'image_uri', 'imageUri',
  'origin_web_uri', 'originWebUri', 'web_uri', 'webUri', 'tos_uri', 'tosUri', 'uri',
]
const TRUSTED_IMAGE_HOST = /(^|\.)(toutiaoimg\.com|toutiaocdn\.com|pstatp\.com|byteimg\.com)$/i

function scalarString(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (Array.isArray(value)) {
    for (const item of value) {
      const candidate = scalarString(item)
      if (candidate) return candidate
    }
  }
  return ''
}

function uploadResponseObjects(value: unknown): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = []
  const queue: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }]
  while (queue.length) {
    const current = queue.shift()!
    if (!current.value || current.depth > 5) continue
    if (Array.isArray(current.value)) {
      for (const item of current.value) queue.push({ value: item, depth: current.depth + 1 })
      continue
    }
    if (typeof current.value !== 'object') continue
    const record = current.value as Record<string, unknown>
    result.push(record)
    for (const nested of Object.values(record)) {
      if (nested && typeof nested === 'object') queue.push({ value: nested, depth: current.depth + 1 })
    }
  }
  return result
}

function fieldFromObjects(objects: Record<string, unknown>[], keys: string[]): string {
  for (const object of objects) {
    for (const key of keys) {
      const candidate = scalarString(object[key])
      if (candidate) return candidate
    }
  }
  return ''
}

function normalizeImageResourceUri(value: string): string {
  const candidate = value.trim().replace(/^\/+/, '').split(/[?#]/)[0].split('~')[0]
  if (!candidate || candidate.length > 1024 || /[\\\u0000-\u001f\u007f]/.test(candidate)) return ''
  if (candidate.split('/').some((segment) => segment === '..')) return ''
  return /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(candidate) ? candidate : ''
}

function trustedImageUrl(value: string): string {
  const normalized = normalizeImageUrl(value)
  try {
    const parsed = new URL(normalized)
    const trustedHost = TRUSTED_IMAGE_HOST.test(parsed.hostname) || parsed.hostname.toLowerCase() === 'image-tt-private.toutiao.com'
    if (parsed.protocol !== 'https:' || !trustedHost || parsed.username || parsed.password) return ''
    if (parsed.port && parsed.port !== '443') return ''
    return parsed.toString()
  } catch {
    return ''
  }
}

function deriveTrustedWebUri(url: string): string {
  try {
    const parsed = new URL(url)
    const trustedHost = TRUSTED_IMAGE_HOST.test(parsed.hostname) || parsed.hostname.toLowerCase() === 'image-tt-private.toutiao.com'
    if (parsed.protocol !== 'https:' || !trustedHost) return ''
    for (const key of IMAGE_URI_KEYS) {
      const queryValue = parsed.searchParams.get(key)
      const resourceUri = normalizeImageResourceUri(queryValue || '')
      if (resourceUri) return resourceUri
    }
    return normalizeImageResourceUri(decodeURIComponent(parsed.pathname))
  } catch {
    return ''
  }
}

function imageUploadShape(value: unknown): string {
  const keys = new Set<string>()
  for (const object of uploadResponseObjects(value)) {
    for (const key of Object.keys(object)) keys.add(key)
  }
  return [...keys].slice(0, 16).join(', ') || '无可识别字段'
}

function toutiaoFailureDetail(envelope: any, securityTokenAttached: boolean): string {
  const objects = uploadResponseObjects(envelope)
  const message = fieldFromObjects(objects, ['reason', 'message', 'msg', 'error_msg', 'errorMessage', 'description', 'prompt', 'toast'])
  const prompt = fieldFromObjects(objects.slice(1), ['prompt', 'toast', 'description', 'reason', 'message', 'msg'])
  const codeObject = objects.find((item) => item.code !== undefined || item.err_no !== undefined || item.errNo !== undefined)
  const code = codeObject ? String(codeObject.code ?? codeObject.err_no ?? codeObject.errNo ?? '') : ''
  const trace = fieldFromObjects(objects, ['trace_id', 'traceId', 'log_id', 'logId'])
  const diagnostics = [
    code ? `code=${code}` : '',
    `页面安全令牌=${securityTokenAttached ? '已附加' : '未取得'}`,
    trace ? `traceId=${trace}` : '',
  ].filter(Boolean).join('；')
  const detail = prompt && prompt !== message ? `${message || '头条号保存草稿失败'}：${prompt}` : (message || '头条号保存草稿失败')
  return `${detail}${diagnostics ? `（${diagnostics}）` : ''}`
}

function textLengthFromHtml(html: string): number {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&(?:amp|lt|gt|quot|#39);/gi, 'x')
    .trim().length
}

function addToutiaoParagraphTracking(html: string): string {
  return html.replace(/<p(?!\s[^>]*\bdata-track=)(?![^>]*>\s*<img\b)([^>]*)>/gi, '<p data-track="1"$1>')
}

function findDraftRecord(envelope: any): { id: string; title: string; content: string } | null {
  const candidates = [envelope?.data?.article, envelope?.data, envelope?.article, envelope]
  for (const item of candidates) {
    if (!item || typeof item !== 'object') continue
    const id = String(item.pgc_id ?? item.pgcId ?? item.id ?? '')
    const title = String(item.title ?? '')
    const content = String(item.content ?? '')
    if (/^[0-9]+$/.test(id) && content.trim()) return { id, title, content }
  }
  return null
}

export class ToutiaoAdapter extends CodeAdapter {
  readonly meta: PlatformMeta = {
    id: 'toutiao',
    name: '头条号',
    icon: 'https://mp.toutiao.com/favicon.ico',
    homepage: EDITOR_URL,
    capabilities: ['article', 'draft', 'image_upload'],
  }

  readonly preprocessConfig = {
    outputFormat: 'html' as const,
    removeIframes: true,
    removeComments: true,
    removeSpecialTags: true,
    processLazyImages: true,
    removeEmptyImages: true,
    removeSrcset: true,
    removeSizes: true,
  }

  private editorTabId: number | null = null

  async checkAuth(): Promise<AuthResult> {
    try {
      const response = await this.runtime.fetch('https://mp.toutiao.com/mp/agw/media/get_media_info', {
        method: 'GET', credentials: 'include',
      })
      if (!response.ok) return { isAuthenticated: false }
      const raw = await response.text()
      const result = parseJson(raw)
      const user = result?.data?.user || result?.user || result?.data?.media || result?.data
      const userId = String(user?.id_str ?? user?.id ?? user?.user_id ?? '')
      if (!userId || userId === '0') return { isAuthenticated: false }
      return {
        isAuthenticated: true,
        userId,
        username: String(user?.screen_name ?? user?.display_name ?? user?.name ?? ''),
        avatar: String(user?.https_avatar_url ?? user?.avatar_url ?? ''),
      }
    } catch (error) {
      return { isAuthenticated: false, error: (error as Error).message }
    }
  }

  async publish(_article: Article, _options?: PublishOptions): Promise<SyncResult> {
    throw new Error('头条号公开发布已禁用；仅允许通过受保护的 saveDraft 工作流保存草稿')
  }

  async saveDraft(article: Article, options?: PublishOptions): Promise<SyncResult> {
    try {
      const authorization = options?.draftAuthorization
      if (authorization?.action !== 'saveDraft'
        || authorization.platform !== 'toutiao'
        || !/^tsk_[0-9]+_[0-9a-f]{8}$/.test(authorization.taskId || '')
        || !/^snap-[0-9a-f]{24}$/.test(authorization.snapshotId || '')) {
        throw new Error('头条号 saveDraft 缺少本地服务签发的任务/快照授权')
      }
      await options?.onDraftStage?.('running')

      const auth = await this.checkAuth()
      if (!auth.isAuthenticated) throw new Error('请先在当前 Chrome 登录头条号')
      await this.ensureEditorTab()

      const canonical = parseCanonicalArticle(article.html || '', article.title)
      if (!canonical.blocks.length) throw new Error('发布包 HTML 没有可保存的正文块')
      // 头条图片描述当前最多 50 字；不截断，超限直接阻止。
      assertCaptionPolicy(canonical, 50)
      let content = renderCanonicalArticle(canonical)

      await options?.onDraftStage?.('uploading')
      content = await this.processImages(content, (src) => this.uploadImageByUrl(src), {
        skipPatterns: ['toutiaoimg.com', 'toutiaocdn.com', 'pstatp.com'],
        onProgress: options?.onImageProgress,
      })
      content = content.replace(
        /<figure>\s*(<img\b[^>]*>)\s*<figcaption>([\s\S]*?)<\/figcaption>\s*<\/figure>/gi,
        '<div class="pgc-img">$1<p class="pgc-img-caption">$2</p></div>',
      )
      content = addToutiaoParagraphTracking(content)

      await options?.onDraftStage?.('filling')
      // 先把文章真实写入头条官方编辑器。这样页面自身的编辑器状态、自动保存
      // 和动态安全运行时都能看到这篇文章；即使后续协议保存被平台拒绝，用户
      // 打开的也不再是空白页面，可在官方编辑器中继续检查和手工保存。
      const fillResult = await this.fillOfficialEditor(article.title, content)
      if (!fillResult.titleFilled || !fillResult.bodyFilled) {
        throw new Error(`头条号页面导入失败：标题框=${fillResult.titleKind || '未找到'}；正文框=${fillResult.bodyKind || '未找到'}。请刷新头条图文编辑页后重试`)
      }
      const defaults = await this.getArticleDefaults(auth.userId || '')
      const titleId = defaults.mediaId ? `${Date.now()}_${defaults.mediaId}` : ''
      const summary = String(article.summary || '').trim()
      const extra = {
        content_source: 100000000402,
        content_word_cnt: textLengthFromHtml(content),
        is_multi_title: 0,
        sub_titles: [],
        gd_ext: {
          entrance: '',
          from_page: 'publisher_mp',
          enter_from: 'PC',
          device_platform: 'mp',
          is_message: 0,
        },
        tuwen_wtt_transfer_switch: '1',
      }
      const form: Record<string, string> = {
        source: '29',
        extra: JSON.stringify(extra),
        title: article.title,
        content,
        title_id: titleId,
        search_creation_info: JSON.stringify({ searchTopOne: 0, abstract: summary, clue_id: '' }),
        mp_editor_stat: '{}',
        is_refute_rumor: '0',
        save: '0',
        entrance: '',
        timer_status: '0',
        timer_time: '',
        article_type: '0',
        pgc_id: '',
        educluecard: '',
        draft_form_data: JSON.stringify({ coverType: 2 }),
        pgc_feed_covers: '[]',
        article_ad_type: defaults.articleAdType,
        is_fans_article: '0',
        govern_forward: '0',
        praise: '0',
        disable_praise: '0',
        tree_plan_article: '0',
        star_order_id: '',
        star_order_name: '',
        customer_nick_name: '',
        activity_tag: '0',
        trends_writing_tag: '',
        claim_exclusive: '0',
      }
      if (form.save !== '0') throw new Error('头条号草稿安全参数异常，已阻止请求')

      await options?.onDraftStage?.('saving_draft')
      // 头条的写接口会逐步启用 SecSDK CSRF 校验。普通 page fetch 不会
      // 自动经过站点 axios 拦截器，因此先走官方握手并把短期 token 仅用于
      // 本次同源保存请求；不复制、不持久化，也不返回给扩展后台。
      const securityToken = await this.getPageSecurityToken()
      const saveResponse = await this.pageRequest({
        url: `/mp/agw/article/publish?source=mp&type=article&aid=1231&mp_publish_ab_val=${encodeURIComponent(defaults.publishAb)}`,
        method: 'POST',
        headers: {
          Accept: 'application/json, text/plain, */*',
          'X-Requested-With': 'XMLHttpRequest',
          ...(securityToken ? { 'x-secsdk-csrf-token': securityToken } : {}),
        },
        form,
      })
      let saved: any = null
      try { saved = parseJson(saveResponse.text) } catch { /* HTTP/body detail handled below */ }
      if (!saveResponse.ok) {
        const detail = saved ? toutiaoFailureDetail(saved, Boolean(securityToken)) : saveResponse.text.slice(0, 180)
        throw new Error(`头条号保存草稿失败: HTTP ${saveResponse.status}${detail ? `；${detail}` : ''}`)
      }
      if (!saved || Number(saved?.code) !== 0) throw new Error(toutiaoFailureDetail(saved, Boolean(securityToken)))
      const postId = String(saved?.data?.pgc_id ?? saved?.data?.pgcId ?? '')
      if (!/^[0-9]+$/.test(postId)) throw new Error('头条号保存草稿响应缺少有效草稿 ID')

      const readResponse = await this.pageRequest({
        url: `/mp/agw/article/edit?pgc_id=${encodeURIComponent(postId)}&wxstyle=0&format=json`,
        method: 'GET',
      })
      if (!readResponse.ok) throw new Error(`头条号草稿回读失败: HTTP ${readResponse.status}`)
      const readEnvelope = parseJson(readResponse.text)
      if (readEnvelope?.code !== undefined && Number(readEnvelope.code) !== 0) throw new Error('头条号草稿回读接口返回失败')
      const readBack = findDraftRecord(readEnvelope)
      if (!readBack || readBack.id !== postId) throw new Error('头条号草稿回读内容与本次保存不一致')

      const draftUrl = `${EDITOR_URL}?from=edit&pgc_id=${postId}`
      const fidelityReport = validateCanonicalFidelity(canonical, readBack.content, readBack.title)
      fidelityReport.checks.push(
        { key: 'trusted-draft-url', status: 'PASS', required: true, detail: '头条号 HTTPS 编辑草稿 URL' },
        { key: 'draft-only', status: 'PASS', required: true, detail: '官方草稿参数固定 save=0；未执行 save=1 公开发布' },
        { key: 'read-back-verified', status: 'PASS', required: true, detail: '已从头条号文章编辑接口回读草稿' },
      )
      fidelityReport.summary.pass += 3

      return this.createResult(true, {
        postId,
        postUrl: draftUrl,
        draftOnly: true,
        readBackVerified: true,
        fidelityVerified: fidelityReport.fidelityVerified,
        fidelityReport,
      })
    } catch (error) {
      logger.error('Guarded draft save failed', error)
      return this.createResult(false, { error: (error as Error).message })
    }
  }

  protected async uploadImageByUrl(src: string): Promise<ImageUploadResult> {
    const response = await this.pageRequest({
      url: '/spice/image?upload_source=20020002&need_enhance=true&aid=1231&device_platform=web&scene=paste',
      method: 'POST',
      imageSource: src,
    })
    if (!response.ok) throw new Error(`头条号图片上传失败: HTTP ${response.status}`)
    const envelope = parseJson(response.text)
    if (Number(envelope?.code) !== 0) throw new Error(String(envelope?.message || '头条号图片上传失败'))
    const data = envelope?.data ?? envelope?.result ?? envelope
    const objects = uploadResponseObjects(data)
    const rawUrl = fieldFromObjects(objects, IMAGE_URL_KEYS)
    const responseUri = normalizeImageResourceUri(fieldFromObjects(objects, IMAGE_URI_KEYS))
    const resourceUri = responseUri || normalizeImageResourceUri(rawUrl)
    const url = trustedImageUrl(rawUrl) || (resourceUri ? `https://p1.toutiaoimg.com/origin/${resourceUri}` : '')
    const webUri = resourceUri || deriveTrustedWebUri(url)
    if (!url || !webUri) {
      throw new Error(`头条号图片上传响应缺少 URL 或 web_uri（响应字段：${imageUploadShape(data)}）`)
    }
    const imageData = objects.find((object) => IMAGE_URL_KEYS.some((key) => scalarString(object[key]) === rawUrl)) || objects[0] || {}
    return {
      url,
      attrs: {
        web_uri: webUri,
        image_type: 1,
        mime_type: String(imageData.mime_type || imageData.mimeType || imageData.image_mime_type || imageData.imageMimeType || 'image/jpeg'),
        img_width: Number(imageData.width || imageData.img_width || imageData.imgWidth || imageData.image_width || imageData.imageWidth || 0),
        img_height: Number(imageData.height || imageData.img_height || imageData.imgHeight || imageData.image_height || imageData.imageHeight || 0),
      },
    }
  }

  private async ensureEditorTab(): Promise<number> {
    if (!this.runtime.tabs) throw new Error('当前运行环境不支持头条号页面安全请求')
    if (this.editorTabId !== null) return this.editorTabId
    const existing = await this.runtime.tabs.query(`${EDITOR_URL}*`)
    if (existing[0]) {
      this.editorTabId = existing[0].id
      return existing[0].id
    }
    const created = await this.runtime.tabs.create(EDITOR_URL, false)
    await this.runtime.tabs.waitForLoad(created.id, 45000)
    this.editorTabId = created.id
    return created.id
  }

  private async getPageSecurityToken(): Promise<string> {
    try {
      const response = await this.pageRequest({
        url: '/mp/agw/media/get_media_info',
        method: 'HEAD',
        headers: {
          'x-secsdk-csrf-request': '1',
          'x-secsdk-csrf-version': '1.2.10',
        },
      })
      const wareToken = String(response.securityToken || '')
      if (!response.ok || !wareToken) return ''
      const parts = wareToken.split(',')
      return parts.length >= 2 ? parts[1].trim() : ''
    } catch (error) {
      logger.warn('Toutiao page security token unavailable', (error as Error).message)
      return ''
    }
  }

  private async fillOfficialEditor(title: string, html: string): Promise<EditorFillResult> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const tabId = await this.ensureEditorTab()
      try {
        return await this.runtime.tabs!.executeScript<EditorFillResult, [{ kind: 'fill-editor'; title: string; html: string }]>(tabId, async (input) => {
      const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
      const visible = (element: Element | null): element is HTMLElement => {
        if (!(element instanceof HTMLElement)) return false
        const rect = element.getBoundingClientRect()
        const style = getComputedStyle(element)
        return rect.width > 20 && rect.height > 10 && style.display !== 'none' && style.visibility !== 'hidden'
      }
      const titleSelectors = [
        'textarea[placeholder*="请输入文章标题"]',
        'input[placeholder*="请输入文章标题"]',
        '[contenteditable="true"][data-placeholder*="请输入文章标题"]',
        '[contenteditable="true"][placeholder*="请输入文章标题"]',
      ]
      const bodySelectors = [
        '.ProseMirror[contenteditable="true"]',
        '[contenteditable="true"][data-placeholder*="请输入正文"]',
        '[contenteditable="true"][placeholder*="请输入正文"]',
        '[contenteditable="true"][aria-label*="正文"]',
      ]
      let titleElement: HTMLElement | null = null
      let bodyElement: HTMLElement | null = null
      for (let attempt = 0; attempt < 40; attempt++) {
        titleElement = titleSelectors.map((selector) => document.querySelector(selector)).find(visible) || null
        bodyElement = bodySelectors.map((selector) => document.querySelector(selector)).find(visible) || null
        if (!bodyElement) {
          bodyElement = Array.from(document.querySelectorAll('[contenteditable="true"]'))
            .filter(visible)
            .filter((element) => element !== titleElement)
            .sort((a, b) => {
              const aRect = a.getBoundingClientRect()
              const bRect = b.getBoundingClientRect()
              return (bRect.width * bRect.height) - (aRect.width * aRect.height)
            })[0] as HTMLElement | undefined || null
        }
        if (titleElement && bodyElement) break
        await sleep(250)
      }

      const dispatchEditEvents = (element: HTMLElement, inputType: string) => {
        try {
          element.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType }))
        } catch {
          element.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
        }
        element.dispatchEvent(new Event('change', { bubbles: true, composed: true }))
      }
      const stripLeadingEditorPlaceholders = (element: HTMLElement) => {
        let removed = false
        while (element.firstChild) {
          const first = element.firstChild
          if (first.nodeType === Node.TEXT_NODE) {
            const text = String(first.textContent || '').replace(/[\u200B-\u200D\u2060\uFEFF\u00A0]/g, '').trim()
            if (text) break
            element.removeChild(first)
            removed = true
            continue
          }
          if (!(first instanceof HTMLElement)) break
          const tag = first.tagName.toLowerCase()
          const text = String(first.textContent || '').replace(/[\u200B-\u200D\u2060\uFEFF\u00A0]/g, '').trim()
          const hasContent = Boolean(first.querySelector('img, video, audio, iframe, table, hr'))
          if (!hasContent && !text && (tag === 'p' || tag === 'div' || tag === 'br')) {
            element.removeChild(first)
            removed = true
            continue
          }
          break
        }
        return removed
      }
      const replaceEditable = (element: HTMLElement, value: string, isHtml: boolean) => {
        element.focus()
        if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
          const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
          const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
          if (setter) setter.call(element, value)
          else element.value = value
          dispatchEditEvents(element, 'insertText')
          return element.value.trim().length > 0
        }
        const selection = window.getSelection()
        const range = document.createRange()
        range.selectNodeContents(element)
        selection?.removeAllRanges()
        selection?.addRange(range)
        let inserted = false
        try { inserted = document.execCommand(isHtml ? 'insertHTML' : 'insertText', false, value) } catch { /* fallback below */ }
        const current = String(element.textContent || '').trim()
        if (!inserted || !current) {
          if (isHtml) element.innerHTML = value
          else element.textContent = value
          dispatchEditEvents(element, isHtml ? 'insertFromPaste' : 'insertText')
        }
        // ProseMirror starts a new article with an empty <p><br></p>. Chrome's
        // insertHTML may preserve that placeholder before the imported blocks,
        // which appears as an unwanted blank first line. Remove only consecutive
        // empty block placeholders at the root; intentional spacing inside the
        // article remains untouched.
        if (isHtml && stripLeadingEditorPlaceholders(element)) {
          dispatchEditEvents(element, 'insertFromPaste')
        }
        return String(element.textContent || '').trim().length > 0 || Boolean(element.querySelector('img'))
      }

      const titleFilled = titleElement ? replaceEditable(titleElement, input.title, false) : false
      const bodyFilled = bodyElement ? replaceEditable(bodyElement, input.html, true) : false
      if (bodyElement) bodyElement.blur()
      return {
        titleFilled,
        bodyFilled,
        titleKind: titleElement ? `${titleElement.tagName.toLowerCase()}${titleElement.getAttribute('contenteditable') === 'true' ? '[contenteditable]' : ''}` : '',
        bodyKind: bodyElement ? `${bodyElement.tagName.toLowerCase()}[contenteditable]` : '',
      }
        }, [{ kind: 'fill-editor', title, html }])
      } catch (error) {
        const message = String((error as Error)?.message || '')
        const transient = /Tabs cannot be edited right now|user may be dragging a tab|No tab with id|Frame with ID .* was removed|cannot be edited/i.test(message)
        if (attempt === 0 && transient) {
          if (/No tab with id|Frame with ID .* was removed/i.test(message)) this.editorTabId = null
          await new Promise((resolve) => setTimeout(resolve, 350))
          continue
        }
        throw error
      }
    }
    throw new Error('头条号编辑页暂时不可导入；请刷新编辑页后重试')
  }

  private async getArticleDefaults(fallbackMediaId: string): Promise<ToutiaoArticleDefaults> {
    const response = await this.pageRequest({
      url: '/mp/agw/article/new?article_type=0&format=json&compat=1&column_no=',
      method: 'GET',
      headers: { Accept: 'application/json, text/plain, */*' },
    })
    if (!response.ok) throw new Error(`头条号文章初始化失败: HTTP ${response.status}`)
    const envelope = parseJson(response.text)
    if (envelope?.code !== undefined && Number(envelope.code) !== 0) {
      throw new Error(`头条号文章初始化失败：${toutiaoFailureDetail(envelope, false)}`)
    }
    const data = envelope?.data && typeof envelope.data === 'object' ? envelope.data : {}
    const media = data?.media && typeof data.media === 'object' ? data.media : {}
    const mediaId = String(data.media_id ?? data.mediaId ?? media.id ?? fallbackMediaId ?? '').trim()
    const articleAdTypeValue = Number(data.article_ad_type ?? data.articleAdType ?? 3)
    const articleAdType = Number.isFinite(articleAdTypeValue) && articleAdTypeValue >= 0
      ? String(Math.trunc(articleAdTypeValue))
      : '3'
    const rawPublishAb = String(data.mp_publish_ab_val ?? data.mpPublishAbVal ?? '0')
    const publishAb = /^[A-Za-z0-9._-]{1,64}$/.test(rawPublishAb) ? rawPublishAb : '0'
    return { mediaId, articleAdType, publishAb }
  }

  private async pageRequest(request: PageRequest): Promise<PageResponse> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const tabId = await this.ensureEditorTab()
      try {
        return await this.runtime.tabs!.executeScript<PageResponse, [PageRequest]>(tabId, async (input) => {
          const headers: Record<string, string> = { ...(input.headers || {}) }
          const init: RequestInit = { method: input.method, credentials: 'include', headers }
          if (input.form) {
            headers['Content-Type'] = 'application/x-www-form-urlencoded;charset=UTF-8'
            init.body = new URLSearchParams(input.form)
          } else if (input.imageSource) {
            const sourceResponse = await fetch(input.imageSource)
            if (!sourceResponse.ok) throw new Error(`图片读取失败: ${sourceResponse.status}`)
            const blob = await sourceResponse.blob()
            const formData = new FormData()
            formData.append('image', blob, 'image.jpg')
            init.body = formData
          }
          const response = await fetch(input.url, init)
          return {
            ok: response.ok,
            status: response.status,
            text: input.method === 'HEAD' ? '' : await response.text(),
            securityToken: response.headers.get('x-ware-csrf-token') || undefined,
          }
        }, [request])
      } catch (error) {
        const message = String((error as Error)?.message || '')
        const tabWasTransientlyLocked = /Tabs cannot be edited right now|user may be dragging a tab/i.test(message)
        const tabBecameStale = /No tab with id|Frame with ID .* was removed|cannot be edited/i.test(message)
        if (attempt === 0 && (tabWasTransientlyLocked || tabBecameStale)) {
          if (tabBecameStale) this.editorTabId = null
          await new Promise((resolve) => setTimeout(resolve, 350))
          continue
        }
        throw error
      }
    }
    throw new Error('头条号编辑页暂时不可用；请刷新编辑页后重试')
  }
}
