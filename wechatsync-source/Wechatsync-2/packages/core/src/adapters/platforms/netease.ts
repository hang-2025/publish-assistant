/**
 * 网易号受保护草稿适配器。
 *
 * 请求只在当前 Chrome 的网易号编辑页 MAIN world 执行，不读取、复制或保存
 * Cookie/Profile。保存接口的 operation 永久固定为 saveDraft；publish() 始终拒绝。
 */
import { CodeAdapter, type ImageUploadResult } from '../code-adapter'
import type { Article, AuthResult, PlatformMeta, SyncResult } from '../../types'
import type { PublishOptions } from '../types'
import { createLogger } from '../../lib/logger'
import { assertCaptionPolicy, parseCanonicalArticle, renderCanonicalArticle, validateCanonicalFidelity } from '../../article/canonical'
import type { CanonicalArticle, FidelityReport } from '../../article/canonical'

const logger = createLogger('Netease')
const EDITOR_URL = 'https://mp.163.com/subscribe_v4/index.html#/article-publish'
// 网易号网页通过 Axios 的 baseURL=/wemedia 访问这些相对接口。这里使用
// window.fetch，必须显式补上同一前缀，否则会错误请求到 mp.163.com/article/*。
const API_PREFIX = '/wemedia'

type PageRequest = {
  url?: string
  method?: 'GET' | 'POST'
  form?: Record<string, string>
  imageSource?: string
  guardian?: true
}
type PageResponse = { ok: boolean; status: number; text: string }

// 网易官方编辑器在 MAIN world 暴露的风控对象。这里只调用官方 getToken，
// 不实现、不替代、更不绕过平台风控。
declare const neg: { getToken(): Promise<{ code?: number; token?: string }> } | undefined

function parseJson(text: string): any {
  const value = JSON.parse(text)
  return typeof value === 'string' ? JSON.parse(value) : value
}

function accountRecord(envelope: any): { id: string; name: string; avatar: string } | null {
  // 当前网易号前端用 /navinfo.do 读取登录账号，成功码兼容 1 与
  // 100021；旧 postpage 接口需要 wemediaId 参数，不能用于登录探测。
  if (![1, 100021].includes(Number(envelope?.code))) return null
  const candidates = [
    envelope?.data?.post, envelope?.data?.user, envelope?.data?.userInfo,
    envelope?.data?.wemedia, envelope?.data?.media, envelope?.data, envelope,
  ]
  for (const item of candidates) {
    if (!item || typeof item !== 'object') continue
    const id = String(item.wemediaId ?? item.mediaId ?? item.wemediaid ?? '')
    if (/^[A-Za-z0-9_-]+$/.test(id)) return {
      id,
      name: String(item.mediaName ?? item.wemediaName ?? item.nickname ?? ''),
      avatar: String(item.icon ?? item.avatar ?? ''),
    }
  }
  return null
}

function draftRecord(envelope: any): { id: string; title: string; content: string } | null {
  if (Number(envelope?.code) !== 1) return null
  const candidates = [envelope?.data?.post, envelope?.data?.article, envelope?.data, envelope]
  for (const item of candidates) {
    if (!item || typeof item !== 'object') continue
    const id = String(item.docid ?? item.docId ?? item.postId ?? item.id ?? '')
    // 网易官方编辑器把回读正文写在 data.post.body；content 是部分旧响应
    // 使用过的字段。两者都只作为回读校验输入，不改变保存时提交的正文。
    const content = String(item.body ?? item.content ?? '')
    if (/^[A-Za-z0-9_-]+$/.test(id) && content.trim()) return { id, title: String(item.title ?? ''), content }
  }
  return null
}

function savedDocId(envelope: any): string {
  if (Number(envelope?.code) !== 1) return ''
  if (typeof envelope.data === 'string') {
    const value = new URLSearchParams(envelope.data).get('docId') || new URLSearchParams(envelope.data).get('docid') || ''
    if (/^[A-Za-z0-9_-]+$/.test(value)) return value
  }
  const value = String(envelope?.data?.docId ?? envelope?.data?.docid ?? envelope?.docId ?? '')
  return /^[A-Za-z0-9_-]+$/.test(value) ? value : ''
}

function trustedImageUrl(value: string): string {
  const normalized = value.startsWith('//') ? `https:${value}` : value
  try {
    const url = new URL(normalized)
    const trusted = ['163.com', '126.net', '127.net'].some((suffix) => url.hostname === suffix || url.hostname.endsWith(`.${suffix}`))
    if (!trusted || !['http:', 'https:'].includes(url.protocol)) return ''
    // 网易上传接口仍可能返回旗下 CDN 的 http 地址。只对已通过域名
    // 白名单的网易地址升级协议，最终正文中仍只允许 HTTPS。
    url.protocol = 'https:'
    return url.toString()
  } catch { return '' }
}

function uploadedImageCandidates(envelope: any): string[] {
  const candidates: unknown[] = [
    envelope?.url, envelope?.picUrl, envelope?.imageUrl, envelope?.src,
    envelope?.data,
    envelope?.data?.url, envelope?.data?.picUrl, envelope?.data?.imageUrl, envelope?.data?.src,
    envelope?.data?.result?.url, envelope?.data?.result?.picUrl, envelope?.data?.result?.src,
    envelope?.result?.url, envelope?.result?.picUrl, envelope?.result?.src,
  ]
  return candidates.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
}

const compactNeteaseText = (value: string) => String(value || '').replace(/[\s\u200B-\u200D\uFEFF]+/g, '')

/**
 * 网易会把相邻标题/段落拆分或合并，HTML 块数并不稳定。正文字符顺序和
 * 每张图片前的累计正文字符位置才是稳定语义；图片数、顺序和图注仍沿用
 * canonical 的严格校验，不能因平台重排标签而放宽。
 */
export function validateNeteaseFidelity(source: CanonicalArticle, readBackHtml: string, readBackTitle: string): FidelityReport {
  const report = validateCanonicalFidelity(source, readBackHtml, readBackTitle)
  const actual = parseCanonicalArticle(readBackHtml, readBackTitle)
  const text = (article: CanonicalArticle) => compactNeteaseText(article.blocks
    .filter((block) => block.kind !== 'image' && block.kind !== 'divider')
    .map((block) => 'text' in block ? block.text : '')
    .join(''))
  const imageOffsets = (article: CanonicalArticle) => {
    let offset = 0
    const result: number[] = []
    for (const block of article.blocks) {
      if (block.kind === 'image') result.push(offset)
      else if (block.kind !== 'divider' && 'text' in block) offset += compactNeteaseText(block.text).length
    }
    return result
  }
  const replace = (key: string, ok: boolean, detail: string) => {
    const check = report.checks.find((item) => item.key === key)
    if (check) { check.status = ok ? 'PASS' : 'FAIL'; check.detail = detail }
  }
  replace('main-block-order', text(source) === text(actual), '正文文字与顺序一致；允许网易合并或拆分 HTML 段落')
  replace('image-anchor', JSON.stringify(imageOffsets(source)) === JSON.stringify(imageOffsets(actual)), '按每张图片前累计正文字符位置核对；不依赖网易重排后的段落数量')
  report.summary = { pass: 0, degraded: 0, unsupported: 0, fail: 0 }
  for (const check of report.checks) report.summary[check.status.toLowerCase() as keyof typeof report.summary]++
  report.fidelityVerified = report.checks.every((check) => !check.required || check.status === 'PASS')
  report.overall = report.fidelityVerified ? (report.summary.degraded ? 'DEGRADED' : 'PASS') : 'FAIL'
  return report
}

export class NeteaseAdapter extends CodeAdapter {
  readonly meta: PlatformMeta = {
    id: 'netease', name: '网易号', icon: 'https://mp.163.com/favicon.ico', homepage: EDITOR_URL,
    capabilities: ['article', 'draft', 'image_upload'],
    authCheckMode: 'interactive',
  }
  readonly preprocessConfig = {
    outputFormat: 'html' as const, removeIframes: true, removeComments: true,
    removeSpecialTags: true, processLazyImages: true, removeEmptyImages: true,
    removeSrcset: true, removeSizes: true,
  }
  private editorTabId: number | null = null
  private accountId = ''

  async checkAuth(): Promise<AuthResult> {
    try {
      await this.ensureEditorTab()
      const response = await this.pageRequest({ url: `${API_PREFIX}/navinfo.do`, method: 'GET' })
      if (!response.ok) return { isAuthenticated: false }
      const account = accountRecord(parseJson(response.text))
      if (!account) return { isAuthenticated: false }
      this.accountId = account.id
      return { isAuthenticated: true, userId: account.id, username: account.name, avatar: account.avatar }
    } catch (error) { return { isAuthenticated: false, error: (error as Error).message } }
  }

  async publish(_article: Article, _options?: PublishOptions): Promise<SyncResult> {
    throw new Error('网易号公开发布已禁用；仅允许通过受保护的 saveDraft 工作流保存草稿')
  }

  async saveDraft(article: Article, options?: PublishOptions): Promise<SyncResult> {
    try {
      const authorization = options?.draftAuthorization
      if (authorization?.action !== 'saveDraft' || authorization.platform !== 'netease'
        || !/^tsk_[0-9]+_[0-9a-f]{8}$/.test(authorization.taskId || '')
        || !/^snap-[0-9a-f]{24}$/.test(authorization.snapshotId || '')) {
        throw new Error('网易号 saveDraft 缺少本地服务签发的任务/快照授权')
      }
      await options?.onDraftStage?.('running')
      const auth = await this.checkAuth()
      if (!auth.isAuthenticated || !this.accountId) throw new Error('请先在当前 Chrome 登录网易号')

      const canonical = parseCanonicalArticle(article.html || '', article.title)
      if (!canonical.blocks.length) throw new Error('发布包 HTML 没有可保存的正文块')
      assertCaptionPolicy(canonical)
      let content = renderCanonicalArticle(canonical)

      await options?.onDraftStage?.('uploading')
      content = await this.processImages(content, (src) => this.uploadImageByUrl(src), {
        skipPatterns: ['163.com', '126.net', '127.net'], onProgress: options?.onImageProgress,
      })
      content = content.replace(
        /<figure>\s*(<img\b[^>]*>)\s*<figcaption>([\s\S]*?)<\/figcaption>\s*<\/figure>/gi,
        '<p class="yizao-netease-image" style="text-align:center;font-size:16px;color:#666">$1<br>$2</p>',
      )

      await options?.onDraftStage?.('filling')
      const guardianResponse = await this.pageRequest({ guardian: true })
      if (!guardianResponse.ok) throw new Error('网易号官方风控令牌不可用，已停止保存草稿')
      const guardian = parseJson(guardianResponse.text)
      if (![200, 201].includes(Number(guardian?.code)) || !String(guardian?.token || '').trim()) {
        throw new Error('网易号官方风控校验未通过，已停止保存草稿')
      }
      const form: Record<string, string> = {
        wemediaId: this.accountId, articleId: '-1', title: article.title, content,
        cover: 'auto', operation: 'saveDraft', scheduled: '0', ursToken: String(guardian.token),
      }
      if (form.operation !== 'saveDraft') throw new Error('网易号草稿安全参数异常，已阻止请求')

      await options?.onDraftStage?.('saving_draft')
      const saveResponse = await this.pageRequest({ url: `${API_PREFIX}/article/status/api/publishV2.do`, method: 'POST', form })
      if (!saveResponse.ok) throw new Error(`网易号保存草稿失败: HTTP ${saveResponse.status}`)
      const envelope = parseJson(saveResponse.text)
      const postId = savedDocId(envelope)
      if (!postId) throw new Error(String(envelope?.message || envelope?.msg || '网易号保存草稿响应缺少有效草稿 ID'))

      let readBack: ReturnType<typeof draftRecord> = null
      let readBackDetail = '内容尚未就绪'
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        // 网易官方编辑器只传 postId。保存后的数据可能短暂尚未同步，因此这里只
        // 重试幂等 GET 回读，绝不重放上面的 publishV2 保存请求。
        const readResponse = await this.pageRequest({
          url: `${API_PREFIX}/article/editpage.do?postId=${encodeURIComponent(postId)}`,
          method: 'GET',
        })
        if (readResponse.ok) {
          try {
            const readEnvelope = parseJson(readResponse.text)
            const candidate = draftRecord(readEnvelope)
            if (candidate?.id === postId) {
              readBack = candidate
              break
            }
            readBackDetail = candidate
              ? `返回的草稿 ID 为 ${candidate.id}`
              : `正文尚未返回（响应码 ${String(readEnvelope?.code ?? '未知')}）`
          } catch {
            readBackDetail = '平台返回了无法识别的数据'
          }
        } else {
          readBackDetail = `HTTP ${readResponse.status}`
        }
        if (attempt < 5) await this.delay(attempt * 500)
      }
      if (!readBack) {
        throw new Error(`网易号草稿已保存，但回读确认未完成（已自动重试 5 次：${readBackDetail}）`)
      }

      const draftUrl = `${EDITOR_URL}/${encodeURIComponent(postId)}`
      const fidelityReport = validateNeteaseFidelity(canonical, readBack.content, readBack.title)
      fidelityReport.checks.push(
        { key: 'trusted-draft-url', status: 'PASS', required: true, detail: '网易号 HTTPS 编辑草稿 URL' },
        { key: 'draft-only', status: 'PASS', required: true, detail: '官方操作参数固定 operation=saveDraft；未执行 operation=publish' },
        { key: 'read-back-verified', status: 'PASS', required: true, detail: '已从网易号文章编辑接口回读草稿' },
        { key: 'guardian-token', status: 'PASS', required: true, detail: '保存前已通过网易号官方页面风控令牌检查' },
      )
      fidelityReport.summary.pass += 4
      return this.createResult(true, {
        postId, postUrl: draftUrl, draftOnly: true, readBackVerified: true,
        fidelityVerified: fidelityReport.fidelityVerified, fidelityReport,
      })
    } catch (error) {
      logger.error('Guarded draft save failed', error)
      return this.createResult(false, { error: (error as Error).message })
    }
  }

  protected async uploadImageByUrl(src: string): Promise<ImageUploadResult> {
    let response: PageResponse = { ok: false, status: 0, text: '' }
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      // 图片上传接口挂在前端站点根路径：编辑器自己的上传器请求
      // //mp.163.com/api/v3/upload/picupload（DOMAIN=window.location.host），
      // 不带 /wemedia 前缀。带前缀的旧路径已被网易 302 到跨域 404 页，
      // XHR 跟随跨域重定向会直接报 HTTP 0。
      response = await this.pageRequest({ url: '/api/v3/upload/picupload', method: 'POST', imageSource: src })
      if (response.ok || response.status !== 0 || attempt === 3) break
      // 网易创作页偶尔会在编辑器初始化/路由切换时中断 XHR，并返回 HTTP 0。
      // 只对这种“尚未收到服务器响应”的网络中断做有限重试；明确的 HTTP
      // 错误绝不重放，避免造成不可控的重复请求。
      if (this.editorTabId !== null) {
        await Promise.resolve(this.runtime.tabs?.waitForLoad(this.editorTabId, 15_000)).catch(() => {})
      }
      await new Promise((resolve) => setTimeout(resolve, attempt * 400))
    }
    if (!response.ok) {
      let detail = ''
      try { detail = String(parseJson(response.text)?.error || '') } catch { /* keep status-only error */ }
      if (response.status === 0) {
        throw new Error(`网易号图片上传网络中断（已自动重试 3 次）${detail ? `：${detail}` : '；请刷新网易号创作页，确认页面可正常使用后再点击重试'}`)
      }
      throw new Error(`网易号图片上传失败: HTTP ${response.status}${detail ? `（${detail}）` : ''}`)
    }
    const envelope = parseJson(response.text)
    const responseCode = envelope?.code
    if (responseCode !== undefined && responseCode !== null && ![1, 200].includes(Number(responseCode))) {
      throw new Error(String(envelope?.message || envelope?.msg || '网易号图片上传失败'))
    }
    const url = uploadedImageCandidates(envelope).map(trustedImageUrl).find(Boolean) || ''
    if (!url) {
      const fields = envelope && typeof envelope === 'object' ? Object.keys(envelope).slice(0, 12).join(', ') : typeof envelope
      throw new Error(`网易号图片上传响应缺少受信任的 HTTPS 图片 URL（响应字段：${fields || '空'}）`)
    }
    return { url }
  }

  private async ensureEditorTab(): Promise<number> {
    if (!this.runtime.tabs) throw new Error('当前运行环境不支持网易号页面安全请求')
    if (this.editorTabId !== null) return this.editorTabId
    const existing = await this.runtime.tabs.query('https://mp.163.com/subscribe_v4/index.html*')
    if (existing[0]) { this.editorTabId = existing[0].id; return existing[0].id }
    const created = await this.runtime.tabs.create(EDITOR_URL, false)
    await this.runtime.tabs.waitForLoad(created.id, 45000)
    this.editorTabId = created.id
    return created.id
  }

  private async pageRequest(request: PageRequest): Promise<PageResponse> {
    const tabId = await this.ensureEditorTab()
    const result = await this.runtime.tabs!.executeScript<PageResponse | null, [PageRequest]>(tabId, async (input) => {
      try {
        if (input.guardian) {
          if (typeof neg === 'undefined' || typeof neg?.getToken !== 'function') {
            return { ok: false, status: 0, text: JSON.stringify({ error: 'guardian-unavailable' }) }
          }
          const result = await neg.getToken()
          return { ok: true, status: 200, text: JSON.stringify(result) }
        }
        if (input.imageSource) {
          let blob: Blob
          const matched = input.imageSource.match(/^data:([^;,]+)?;base64,([A-Za-z0-9+/=\r\n]+)$/)
          if (matched) {
            const binary = atob(matched[2].replace(/\s+/g, ''))
            const bytes = new Uint8Array(binary.length)
            for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
            blob = new Blob([bytes], { type: matched[1] || 'image/jpeg' })
          } else {
            const source = await fetch(input.imageSource, { credentials: 'include' })
            if (!source.ok) throw new Error(`图片读取失败: ${source.status}`)
            blob = await source.blob()
          }
          if (blob.size > 10 * 1024 * 1024) throw new Error('网易号图片超过 10MB，已停止上传')
          const form = new FormData()
          form.append('file', blob, 'image.jpg')
          form.append('from', 'neteasecode_mp')
          // 网易编辑器自己的上传器走 XHR。使用相同机制可以稳定取得
          // load/error 回调，避免 MAIN-world fetch 在上传分支返回 undefined。
          return await new Promise<PageResponse>((resolve) => {
            const xhr = new XMLHttpRequest()
            xhr.open('POST', input.url || '', true)
            xhr.withCredentials = true
            xhr.onload = () => resolve({ ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status, text: xhr.responseText || '' })
            xhr.onerror = () => resolve({ ok: false, status: 0, text: JSON.stringify({ error: 'network-error' }) })
            xhr.onabort = () => resolve({ ok: false, status: 0, text: JSON.stringify({ error: 'request-aborted' }) })
            xhr.send(form)
          })
        }
        const init: RequestInit = { method: input.method || 'GET', credentials: 'include' }
        if (input.form) {
          init.headers = { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' }
          init.body = new URLSearchParams(input.form)
        }
        const response = await fetch(input.url || '', init)
        return { ok: response.ok, status: response.status, text: await response.text() }
      } catch (error) {
        return { ok: false, status: 0, text: JSON.stringify({ error: String((error as Error)?.message || error) }) }
      }
    }, [request])
    if (!result || typeof result.ok !== 'boolean' || typeof result.status !== 'number' || typeof result.text !== 'string') {
      throw new Error('网易号页面未返回登录检查结果；请刷新网易号创作页并确认账号仍已登录')
    }
    return result
  }
}
