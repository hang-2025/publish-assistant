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
  method: 'GET' | 'POST'
  form?: Record<string, string>
  imageSource?: string
}

type PageResponse = { ok: boolean; status: number; text: string }

function parseJson(text: string): any {
  const value = JSON.parse(text)
  return typeof value === 'string' ? JSON.parse(value) : value
}

function normalizeImageUrl(value: string): string {
  if (value.startsWith('//')) return `https:${value}`
  if (value.startsWith('/')) return `https://p1.toutiaoimg.com${value}`
  return value
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

      await options?.onDraftStage?.('filling')
      const titleId = `${Date.now()}_${auth.userId}`
      const form: Record<string, string> = {
        title: article.title,
        content,
        title_id: titleId,
        article_type: '0',
        pgc_id: '',
        source: '29',
        save: '0',
        entrance: '',
        timer_status: '0',
        timer_time: '',
        claim_origin: '0',
        article_ad_type: '2',
        is_fans_article: '0',
        govern_forward: '0',
        praise: '0',
        disable_praise: '1',
        community_sync: '0',
        qy_self_recommendation: '0',
        tree_plan_article: '0',
        pgc_feed_covers: '[]',
        extra: JSON.stringify({ content_source: 100000000402 }),
      }
      if (form.save !== '0') throw new Error('头条号草稿安全参数异常，已阻止请求')

      await options?.onDraftStage?.('saving_draft')
      const saveResponse = await this.pageRequest({
        url: '/mp/agw/article/publish?source=mp&type=article&aid=1231',
        method: 'POST',
        form,
      })
      if (!saveResponse.ok) throw new Error(`头条号保存草稿失败: HTTP ${saveResponse.status}`)
      const saved = parseJson(saveResponse.text)
      if (Number(saved?.code) !== 0) throw new Error(String(saved?.reason || saved?.message || '头条号保存草稿失败'))
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
    const data = envelope?.data || {}
    const url = normalizeImageUrl(String(data.url || data.image_url || ''))
    const webUri = String(data.web_uri || data.uri || data.origin_web_uri || '')
    if (!/^https:\/\//.test(url) || !webUri) throw new Error('头条号图片上传响应缺少 URL 或 web_uri')
    return {
      url,
      attrs: {
        web_uri: webUri,
        image_type: 1,
        mime_type: String(data.mime_type || 'image/jpeg'),
        img_width: Number(data.width || data.img_width || 0),
        img_height: Number(data.height || data.img_height || 0),
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

  private async pageRequest(request: PageRequest): Promise<PageResponse> {
    const tabId = await this.ensureEditorTab()
    return this.runtime.tabs!.executeScript<PageResponse, [PageRequest]>(tabId, async (input) => {
      const init: RequestInit = { method: input.method, credentials: 'include' }
      if (input.form) {
        init.headers = { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' }
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
      return { ok: response.ok, status: response.status, text: await response.text() }
    }, [request])
  }
}
