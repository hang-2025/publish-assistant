/**
 * 豆瓣新版日记（topic editor）草稿适配器。
 * 只保存私密草稿；公开发布始终拒绝。
 */
import { CodeAdapter, type ImageUploadResult } from '../code-adapter'
import type { Article, AuthResult, SyncResult, PlatformMeta } from '../../types'
import type { DoubanImageData } from '../../lib'
import type { PublishOptions } from '../types'
import { createLogger } from '../../lib/logger'
import {
  assertCaptionPolicy,
  parseCanonicalArticle,
  renderCanonicalArticle,
  stripDuplicateTitleBlock,
  validateWithCharOffsetFidelity,
} from '../../article/canonical'
import { parseHTML } from 'linkedom'

const logger = createLogger('Douban')
const DOUBAN_DRAFT_API = 'https://m.douban.com/rexxar/api/v2/dwarf'

interface DoubanFormData { ck: string }
interface DoubanDraftProps {
  title: string
  content: { blocks: any[]; entityMap: Record<string, any> }
  subtype: 'note'
  image_ids: string[]
  image_layout?: 'vertical'
}

export class DoubanAdapter extends CodeAdapter {
  readonly meta: PlatformMeta = {
    id: 'douban', name: '豆瓣', icon: 'https://www.douban.com/favicon.ico',
    homepage: 'https://www.douban.com/topic/create?subtype=note',
    capabilities: ['article', 'draft', 'image_upload'],
  }
  readonly preprocessConfig = { outputFormat: 'markdown' as const }
  private username = ''
  private avatar = ''
  private formData: DoubanFormData | null = null
  private noteTabId: number | null = null
  private readonly HEADER_RULES = [{
    urlFilter: '*://www.douban.com/*',
    headers: { Origin: 'https://www.douban.com', Referer: 'https://www.douban.com' },
    resourceTypes: ['xmlhttprequest'],
  }]

  private async ensureNoteTab(): Promise<number> {
    if (!this.runtime.tabs) throw new Error('当前运行环境不支持豆瓣页面安全请求')
    if (this.noteTabId !== null) return this.noteTabId
    const current = await this.runtime.tabs.query('https://www.douban.com/topic/create*')
    if (current[0]) { this.noteTabId = current[0].id; return current[0].id }
    const legacy = await this.runtime.tabs.query('https://www.douban.com/note/create*')
    if (legacy[0]) { this.noteTabId = legacy[0].id; return legacy[0].id }
    const tabs = await this.runtime.tabs.query('https://www.douban.com/*')
    const redirected = [...tabs].reverse().find((tab) => /(?:写|修改)日记|发言/.test(String(tab.title || '')))
    if (redirected) { this.noteTabId = redirected.id; return redirected.id }
    const created = await this.runtime.tabs.create('https://www.douban.com/topic/create?subtype=note', false)
    await this.runtime.tabs.waitForLoad(created.id, 45000)
    this.noteTabId = created.id
    return created.id
  }

  private async notePageRun<T, A extends unknown[]>(fn: (...args: A) => T, args: A): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const tabId = await this.ensureNoteTab()
      try {
        // 豆瓣编辑器在后台标签页会被 Chrome 降频，尤其是上传完图片后紧接着发起草稿请求。
        // 激活是幂等的，只唤醒已经找到的编辑器标签页，不创建新页面，也不触碰用户数据。
        await Promise.resolve(this.runtime.tabs!.activate?.(tabId)).catch(() => {})
        return await this.runtime.tabs!.executeScript<T, A>(tabId, fn, args)
      } catch (error) {
        const message = String((error as Error)?.message || '')
        if (attempt === 0 && (message.includes('No tab with id') || message.includes('cannot be edited') || message.includes('Frame with ID'))) {
          this.noteTabId = null
          continue
        }
        throw error
      }
    }
    throw new Error('豆瓣写日记页不可用；请检查该页面是否已打开且已登录')
  }

  async checkAuth(): Promise<AuthResult> {
    try {
      const page = await this.notePageRun(() => {
        const html = document.documentElement.innerHTML
        const loginWall = /accounts\.douban\.com\/login|sec\.douban/.test(html)
          || Boolean(document.querySelector('a[href*="accounts.douban.com/login"]'))
        const userName = (window as any)._USER_NAME
          || document.querySelector('.db-usr-profile .name h1')?.textContent
          || document.querySelector('meta[name="description"]')?.getAttribute('content')?.slice(0, 40) || ''
        return { userName: String(userName).trim(), avatar: String((window as any)._USER_AVATAR || ''), loginWall, pageTitle: document.title.slice(0, 60) }
      }, [])
      const ck = (await this.runtime.getCookie?.('douban.com', 'ck')) || ''
      if (!ck || page.loginWall) return { isAuthenticated: false, error: `豆瓣登录凭证不可用（页面：${page.pageTitle || '未知'}）；请确认已登录` }
      this.username = page.userName || '当前 Chrome 豆瓣会话'
      this.avatar = page.avatar
      this.formData = { ck }
      return { isAuthenticated: true, userId: this.username, username: this.username, avatar: this.avatar }
    } catch (error) {
      logger.debug('checkAuth: not logged in -', error)
      return { isAuthenticated: false, error: (error as Error).message }
    }
  }

  private buildDoubanDraft(article: ReturnType<typeof parseCanonicalArticle>, images: Map<string, DoubanImageData>) {
    const blocks: any[] = []
    const entityMap: Record<string, any> = {}
    let entityKey = 0
    let blockKey = 0
    const push = (block: any) => blocks.push({ key: String(blockKey++), depth: 0, inlineStyleRanges: [], entityRanges: [], data: {}, ...block })
    for (const block of article.blocks) {
      if (block.kind === 'heading') push({ type: block.level === 1 ? 'header-one' : block.level === 2 ? 'header-two' : 'header-three', text: block.text })
      else if (block.kind === 'image') {
        const image = images.get(block.source)
        if (!image?.id) throw new Error(`图片尚未取得豆瓣媒体 ID：${block.source}`)
        const key = String(entityKey++)
        entityMap[key] = { type: 'IMAGE', mutability: 'IMMUTABLE', data: { ...image, src: image.url, raw_src: image.url } }
        push({ type: 'atomic', text: ' ', entityRanges: [{ offset: 0, length: 1, key }] })
        if (block.alt) push({ type: 'unstyled', text: block.alt })
      } else if (block.kind === 'divider') continue
      else if (block.kind === 'quote') push({ type: 'blockquote', text: block.text })
      else if (block.kind === 'list') {
        const items: string[] = []
        if ('html' in block && block.html) {
          const { document } = parseHTML(`<ul>${block.html}</ul>`)
          document.querySelectorAll('li').forEach((li) => { const text = String(li.textContent || '').replace(/\s+/g, ' ').trim(); if (text) items.push(text) })
        }
        const list = items.length ? items : String(block.text || '').split('\n').map((item) => item.trim()).filter(Boolean)
        for (const item of list) push({ type: (block as any).ordered ? 'ordered-list-item' : 'unordered-list-item', text: item })
      } else if (block.kind === 'table') push({ type: 'unstyled', text: block.text })
      else push({ type: 'unstyled', text: ('text' in block ? block.text : '') })
    }
    return { entityMap, blocks }
  }

  private draftJsonToHtml(raw: unknown): string {
    try {
      const state = (typeof raw === 'string' ? JSON.parse(raw) : raw) as { blocks?: Array<{ type?: string; text?: string; entityRanges?: Array<{ key: number }> }>; entityMap?: Record<string, any> }
      if (!state || !Array.isArray(state.blocks)) return typeof raw === 'string' ? raw : ''
      return state.blocks.map((block) => {
        const text = String(block.text || '').trim()
        const range = (block.entityRanges || [])[0]
        const entity = range ? (state.entityMap?.[String(range.key)] ?? state.entityMap?.[range.key]) : null
        if (entity?.type === 'IMAGE') { const src = String(entity.data?.src || entity.data?.url || ''); return src ? `<p><img src="${src}"></p>` : '<p></p>' }
        if (!text) return ''
        if (block.type === 'header-one') return `<h1>${text}</h1>`
        if (block.type === 'header-two') return `<h2>${text}</h2>`
        if (block.type === 'header-three') return `<h3>${text}</h3>`
        if (block.type === 'blockquote') return `<blockquote>${text}</blockquote>`
        if (block.type === 'ordered-list-item') return `<ol><li>${text}</li></ol>`
        if (block.type === 'unordered-list-item') return `<ul><li>${text}</li></ul>`
        return `<p>${text}</p>`
      }).join('')
    } catch { return typeof raw === 'string' ? raw : '' }
  }

  async saveDraft(article: Article, options?: PublishOptions): Promise<SyncResult> {
    const trace: string[] = []
    const step = (line: string) => { trace.push(line); logger.info('[trace]', line) }
    return this.withHeaderRules(this.HEADER_RULES, async () => {
      const authorization = options?.draftAuthorization
      if (authorization?.action !== 'saveDraft' || authorization.platform !== 'douban'
        || !/^tsk_[0-9]+_[0-9a-f]{8}$/.test(authorization.taskId || '')
        || !/^snap-[0-9a-f]{24}$/.test(authorization.snapshotId || '')) throw new Error('豆瓣 saveDraft 缺少本地服务签发的任务/快照授权')
      await options?.onDraftStage?.('running')
      try {
        const auth = await this.checkAuth()
        if (!auth.isAuthenticated) throw new Error(`登录检查失败：${auth.error || '未登录'}`)
        step('登录凭证:ok')
        const canonical = parseCanonicalArticle(article.html || '', article.title)
        if (!canonical.blocks.length) throw new Error('发布包 HTML 没有可保存的正文块')
        assertCaptionPolicy(canonical)
        stripDuplicateTitleBlock(canonical, article.title)
        step(`正文解析:${canonical.blocks.length} 块 / ${canonical.images.length} 图`)
        await options?.onDraftStage?.('uploading')
        const imageMap = new Map<string, DoubanImageData>()
        for (let index = 0; index < canonical.images.length; index++) {
          const image = canonical.images[index]
          const result = await this.uploadImageWithFullData(image.source)
          imageMap.set(image.source, result.imageData)
          step(`图片${index + 1}/${canonical.images.length}:ok`)
          await options?.onImageProgress?.(index + 1, canonical.images.length)
        }
        const imageIds = [...imageMap.values()].map((image) => String(image.id)).filter(Boolean)
        const props: DoubanDraftProps = {
          title: article.title, content: this.buildDoubanDraft(canonical, imageMap), subtype: 'note', image_ids: imageIds,
          ...(imageIds.length ? { image_layout: 'vertical' as const } : {}),
        }
        await options?.onDraftStage?.('filling')
        await options?.onDraftStage?.('saving_draft')
        const created = await this.notePageRun(async (api: string, ck: string, draftProps: DoubanDraftProps) => {
          // 与豆瓣当前页面的 Axios 请求保持一致：JSON 字符串请求体配合其默认 POST Content-Type。
          const response = await fetch(`${api}/drafts`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-CSRF-TOKEN': ck }, body: JSON.stringify({ draft_props: JSON.stringify(draftProps) }) })
          return { status: response.status, text: (await response.text()).slice(0, 200000) }
        }, [DOUBAN_DRAFT_API, this.formData!.ck, props])
        let createdData: any = null
        try { createdData = JSON.parse(created.text) } catch { /* checked below */ }
        const draftId = String(createdData?.id ?? createdData?.draft?.id ?? '')
        if (created.status < 200 || created.status >= 300 || !draftId) throw new Error(`新版草稿创建失败（HTTP ${created.status}；${created.text.slice(0, 160)}）`)
        step(`新版草稿已保存:id=${draftId}`)
        const read = await this.notePageRun(async (api: string, ck: string, id: string) => {
          const response = await fetch(`${api}/${encodeURIComponent(id)}?ck=${encodeURIComponent(ck)}`, { credentials: 'include' })
          return { status: response.status, text: (await response.text()).slice(0, 200000) }
        }, [DOUBAN_DRAFT_API, this.formData!.ck, draftId])
        let readData: any = null
        try { readData = JSON.parse(read.text) } catch { /* checked below */ }
        if (read.status < 200 || read.status >= 300 || !readData) throw new Error(`新版草稿回读失败（HTTP ${read.status}）`)
        let readProps: any = readData.draft_props ?? readData.draft?.draft_props
        if (typeof readProps === 'string') { try { readProps = JSON.parse(readProps) } catch { readProps = null } }
        if (!readProps?.content) throw new Error('新版草稿已创建，但回读没有取得正文')
        step('新版草稿回读:ok')
        const source = parseCanonicalArticle(article.html || '', article.title)
        stripDuplicateTitleBlock(source, article.title)
        const readArticle = parseCanonicalArticle(this.draftJsonToHtml(readProps.content), String(readProps.title || ''))
        stripDuplicateTitleBlock(readArticle, String(readProps.title || ''))
        const report = validateWithCharOffsetFidelity(source, renderCanonicalArticle(readArticle), String(readProps.title || ''), '豆瓣')
        report.checks.push(
          { key: 'trusted-draft-url', status: 'PASS', required: true, detail: '豆瓣 HTTPS 新版草稿编辑地址' },
          { key: 'draft-only', status: 'PASS', required: true, detail: '只调用 dwarf/drafts；未调用公开发布接口' },
          { key: 'read-back-verified', status: 'PASS', required: true, detail: '已从新版草稿接口按 ID 回读' },
        )
        report.summary.pass += 3
        step(`保真:${report.overall}`)
        return this.createResult(report.fidelityVerified, {
          postId: draftId, postUrl: `https://www.douban.com/topic/create?draft_id=${encodeURIComponent(draftId)}`,
          draftOnly: true, readBackVerified: true, fidelityVerified: report.fidelityVerified, fidelityReport: report,
        })
      } catch (error) {
        throw new Error(`【豆瓣保存轨迹】\n${trace.join('\n')}\n──失败于──\n${(error as Error).message}`)
      }
    }).catch((error) => this.createResult(false, { error: (error as Error).message }))
  }

  async publish(_article: Article, _options?: PublishOptions): Promise<SyncResult> {
    return this.createResult(false, { error: '豆瓣公开发布永久禁用；只允许保存私密草稿' })
  }

  private async uploadImageWithFullData(src: string): Promise<ImageUploadResult & { imageData: DoubanImageData }> {
    if (!this.formData) throw new Error('未获取豆瓣登录凭证')
    const imageResponse = await fetch(src)
    if (!imageResponse.ok) throw new Error(`图片下载失败: ${src}`)
    const imageBlob = await imageResponse.blob()
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result as string)
      reader.onerror = () => reject(new Error('图片转存失败'))
      reader.readAsDataURL(imageBlob)
    })
    const uploaded = await this.notePageRun(async (ck: string, imageDataUrl: string) => {
      const blob = await (await fetch(imageDataUrl)).blob()
      const form = new FormData()
      form.append('ck', ck)
      form.append('image_file', blob, 'image.jpg')
      form.append('primary_color', 'ffffff')
      const token = String((window as any).__INIT_STATE__?.upload_auth_token || '')
      if (token) form.append('upload_auth_token', token)
      const response = await fetch('https://upload.douban.com/j/group/topic/add_photo', { method: 'POST', credentials: 'include', body: form })
      return { status: response.status, text: (await response.text()).slice(0, 4000) }
    }, [this.formData.ck, dataUrl])
    let data: any = null
    try { data = JSON.parse(uploaded.text) } catch { /* checked below */ }
    if (uploaded.status !== 200 || Number(data?.r) !== 0 || !data?.photo?.id || !data?.photo?.url) throw new Error(`图片上传失败（HTTP ${uploaded.status}；${uploaded.text.slice(0, 160)}）`)
    const photo = data.photo
    return {
      url: photo.url,
      imageData: {
        id: String(photo.id), url: String(photo.url), thumb: String(photo.thumb || photo.url),
        width: photo.width, height: photo.height, file_name: photo.file_name, file_size: photo.file_size,
        primary_color: photo.primary_color,
      } as DoubanImageData,
    }
  }
}
