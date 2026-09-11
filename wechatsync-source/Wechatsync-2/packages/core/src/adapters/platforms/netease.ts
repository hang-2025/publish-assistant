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
  if (Number(envelope?.code) !== 1) return null
  const candidates = [envelope?.data?.post, envelope?.data?.user, envelope?.data, envelope]
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
    const content = String(item.content ?? '')
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
    return url.protocol === 'https:' && trusted ? url.toString() : ''
  } catch { return '' }
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
      const response = await this.pageRequest({ url: `${API_PREFIX}/article/postpage.do`, method: 'GET' })
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

      const readResponse = await this.pageRequest({
        url: `${API_PREFIX}/article/editpage.do?postId=${encodeURIComponent(postId)}&wemediaId=${encodeURIComponent(this.accountId)}&mediaId=${encodeURIComponent(this.accountId)}`,
        method: 'GET',
      })
      if (!readResponse.ok) throw new Error(`网易号草稿回读失败: HTTP ${readResponse.status}`)
      const readBack = draftRecord(parseJson(readResponse.text))
      if (!readBack || readBack.id !== postId) throw new Error('网易号草稿回读内容与本次保存不一致')

      const draftUrl = `${EDITOR_URL}/${encodeURIComponent(postId)}`
      const fidelityReport = validateCanonicalFidelity(canonical, readBack.content, readBack.title)
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
    const response = await this.pageRequest({ url: `${API_PREFIX}/api/v3/upload/picupload`, method: 'POST', imageSource: src })
    if (!response.ok) throw new Error(`网易号图片上传失败: HTTP ${response.status}`)
    const envelope = parseJson(response.text)
    if (![1, 200].includes(Number(envelope?.code))) throw new Error(String(envelope?.message || envelope?.msg || '网易号图片上传失败'))
    const candidates = [envelope?.data?.url, envelope?.data?.picUrl, envelope?.url]
    const url = candidates.map((item) => trustedImageUrl(String(item || ''))).find(Boolean) || ''
    if (!url) throw new Error('网易号图片上传响应缺少受信任的 HTTPS 图片 URL')
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
      if (input.guardian) {
        if (typeof neg === 'undefined' || typeof neg?.getToken !== 'function') {
          return { ok: false, status: 0, text: JSON.stringify({ error: 'guardian-unavailable' }) }
        }
        const result = await neg.getToken()
        return { ok: true, status: 200, text: JSON.stringify(result) }
      }
      const init: RequestInit = { method: input.method || 'GET', credentials: 'include' }
      if (input.form) {
        init.headers = { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' }
        init.body = new URLSearchParams(input.form)
      } else if (input.imageSource) {
        const source = await fetch(input.imageSource)
        if (!source.ok) throw new Error(`图片读取失败: ${source.status}`)
        const blob = await source.blob()
        if (blob.size > 10 * 1024 * 1024) throw new Error('网易号图片超过 10MB，已停止上传')
        const form = new FormData()
        form.append('file', blob, 'image.jpg')
        form.append('from', 'neteasecode_mp')
        init.body = form
      }
      const response = await fetch(input.url || '', init)
      return { ok: response.ok, status: response.status, text: await response.text() }
    }, [request])
    if (!result || typeof result.ok !== 'boolean' || typeof result.status !== 'number' || typeof result.text !== 'string') {
      throw new Error('网易号页面未返回登录检查结果；请刷新网易号创作页并确认账号仍已登录')
    }
    return result
  }
}
