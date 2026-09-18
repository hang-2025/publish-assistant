/**
 * 搜狐号适配器
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
import type { CanonicalArticle, CanonicalBlock } from '../../article/canonical'

const logger = createLogger('Sohu')

const compactSohuText = (value: string) => String(value || '').replace(/[\s\u200B-\u200D\uFEFF]+/g, '')

/**
 * 搜狐编辑器保存后会合并/拆分段落，图片前的正文块数不稳定。
 * 每张图片前累计正文字符位置才是稳定语义；图片数、顺序与图注仍沿用
 * canonical 的严格校验。
 */
export function validateSohuFidelity(source: ReturnType<typeof parseCanonicalArticle>, readBackHtml: string, readBackTitle: string): ReturnType<typeof validateCanonicalFidelity> {
  const report = validateCanonicalFidelity(source, readBackHtml, readBackTitle)
  const actual = parseCanonicalArticle(readBackHtml, readBackTitle)
  const orderedText = (article: ReturnType<typeof parseCanonicalArticle>) => article.blocks
    .filter((block) => block.kind !== 'image' && block.kind !== 'divider' && 'text' in block)
    .map((block) => compactSohuText(block.text))
    .filter(Boolean)
    .join('')
  const imageOffsets = (article: ReturnType<typeof parseCanonicalArticle>) => {
    let offset = 0
    const result: number[] = []
    for (const block of article.blocks) {
      if (block.kind === 'image') result.push(offset)
      else if (block.kind !== 'divider' && 'text' in block) offset += compactSohuText(block.text).length
    }
    return result
  }
  // 搜狐会把相邻段落合并、把一个段落拆开，或插入空段落。只要全部正文
  // 字符和先后顺序一致，并且下方图片字符锚点一致，就不应误报正文丢失。
  const mainBlockCheck = report.checks.find((item) => item.key === 'main-block-order')
  const sourceText = orderedText(source)
  const actualText = orderedText(actual)
  if (mainBlockCheck) {
    const ok = sourceText === actualText
    mainBlockCheck.status = ok ? 'PASS' : 'FAIL'
    mainBlockCheck.detail = ok
      ? '正文文字与顺序一致；允许搜狐合并、拆分或插入空段落'
      : `正文文字或顺序不一致；源 ${sourceText.length} 字 / 回读 ${actualText.length} 字`
  }
  const check = report.checks.find((item) => item.key === 'image-anchor')
  const sourceOffsets = imageOffsets(source)
  const actualOffsets = imageOffsets(actual)
  if (check) {
    const ok = JSON.stringify(sourceOffsets) === JSON.stringify(actualOffsets)
    check.status = ok ? 'PASS' : 'FAIL'
    check.detail = ok
      ? '按每张图片前累计正文字符位置核对；允许搜狐合并或拆分段落'
      : `图片锚点不一致；锚点 源=${JSON.stringify(sourceOffsets)} 回读=${JSON.stringify(actualOffsets)}`
  }
  report.summary = { pass: 0, degraded: 0, unsupported: 0, fail: 0 }
  for (const item of report.checks) report.summary[item.status.toLowerCase() as keyof typeof report.summary]++
  report.fidelityVerified = report.checks.every((item) => !item.required || item.status === 'PASS')
  report.overall = report.fidelityVerified ? (report.summary.degraded ? 'DEGRADED' : 'PASS') : 'FAIL'
  return report
}

/**
 * 搜狐编辑器顶部标题栏由接口的 title 字段承担；正文里再放一个相同文字的
 * 大标题会在文章页显示两遍。这里在保存与校验两侧对称地移除该重复标题块。
 */
function stripDuplicateTitleBlock(article: ReturnType<typeof parseCanonicalArticle>, title: string): void {
  const first = article.blocks[0]
  if (!first || first.kind !== 'heading') return
  const drop = (value: string) => value.replace(/[？?！!。:：\s]+$/g, '')
  if (drop(first.text) === drop(title) || drop(title).startsWith(drop(first.text))) article.blocks.shift()
}

/**
 * 映射到搜狐编辑器稳定支持的正文结构：标题栏承担文章标题，正文小标题
 * 使用独立加粗段落，装饰分隔线不导入。表格、列表和引用仍保留原语义。
 */
export function normalizeSohuDraftArticle(article: CanonicalArticle, title: string): CanonicalArticle {
  const source = { ...article, blocks: [...article.blocks], images: [...article.images] }
  stripDuplicateTitleBlock(source, title)

  let anchor = 0
  let imageOrder = 0
  const blocks: CanonicalBlock[] = []
  for (const block of source.blocks) {
    if (block.kind === 'divider') continue
    if (block.kind === 'image') {
      blocks.push({ ...block, order: ++imageOrder, anchor })
      continue
    }
    if (block.kind === 'heading') {
      blocks.push({ kind: 'paragraph', text: block.text, html: `<strong>${block.html}</strong>` })
    } else {
      blocks.push(block)
    }
    anchor++
  }

  const images = blocks.filter((block): block is Extract<CanonicalBlock, { kind: 'image' }> => block.kind === 'image')
  return { ...source, blocks, images }
}

/**
 * 搜狐编辑器（Quill 定制版）的图片描述是其自有序列化结构：
 * `<p><img ...><span class="img-desc" style="font-size: 16px;">描述</span></img></p>`
 * （从该账号已发布文章的原生内容中提取）。编辑器按 class="img-desc" 把
 * 文字填进图片下方描述框；不带该 class 的任何写法都只会降级成普通段落。
 */
function withSohuNativeImageCaptions(content: string): string {
  return content.replace(
    /<figure>\s*(<img\b[^>]*?)>\s*<figcaption>([\s\S]*?)<\/figcaption>\s*<\/figure>/gi,
    (_match, imgTag: string, caption: string) => {
      const inner = imgTag.replace(/\sstyle="[^"]*"/i, '').replace(/\/>$/, '>').trimEnd()
      return `<p style="text-align:center;">${inner}><span class="img-desc" style="font-size: 16px;">${caption}</span></img></p>`
    },
  )
}

interface SohuAccountInfo {
  id: string
  nickName: string
  avatar: string
}

/**
 * 生成设备 ID (dv-id)
 */
function generateDeviceId(): string {
  const chars = '0123456789abcdef'
  let result = ''
  for (let i = 0; i < 32; i++) {
    result += chars[Math.floor(Math.random() * chars.length)]
  }
  return result
}

export class SohuAdapter extends CodeAdapter {
  readonly meta: PlatformMeta = {
    id: 'sohu',
    name: '搜狐号',
    icon: 'https://mp.sohu.com/favicon.ico',
    homepage: 'https://mp.sohu.com/mpfe/v4/?newsType=1',
    capabilities: ['article', 'draft', 'image_upload'],
  }

  /** 预处理配置: 搜狐号使用 HTML 格式 */
  readonly preprocessConfig = {
    outputFormat: 'html' as const,
  }

  private accountInfo: SohuAccountInfo | null = null
  private deviceId: string = generateDeviceId()
  private spCm: string = ''

  /**
   * 搜狐当前编辑器以页面 vuex.app.userInfo 作为正在操作的子账号。
   * 账号列表的第一项不一定是当前选中项，因此只能在受信任的搜狐页中读取，
   * 并再次与 listV2 返回的账号集合交叉验证后使用。
   */
  private async getSelectedPageAccount(accounts: SohuAccountInfo[]): Promise<SohuAccountInfo | null> {
    if (!this.runtime.tabs) return null
    try {
      const tabs = await this.runtime.tabs.query('https://mp.sohu.com/*')
      for (const tab of tabs) {
        const selected = await this.runtime.tabs.executeScript(tab.id, () => {
          try {
            const state = JSON.parse(localStorage.getItem('vuex') || 'null')
            const account = state?.app?.userInfo
            if (!account?.id) return null
            return { id: String(account.id), nickName: String(account.nickName || ''), avatar: String(account.avatar || '') }
          } catch {
            return null
          }
        }, [])
        if (!selected?.id) continue
        const verified = accounts.find((account) => String(account.id) === selected.id)
        if (verified) return verified
      }
    } catch (error) {
      logger.debug('Could not read selected Sohu account from page:', error)
    }
    return null
  }

  /** 搜狐号 API 需要的 Header 规则 */
  private readonly HEADER_RULES = [
    {
      urlFilter: '*://mp.sohu.com/*',
      headers: {
        'Origin': 'https://mp.sohu.com',
        'Referer': 'https://mp.sohu.com/',
      },
      resourceTypes: ['xmlhttprequest'],
    },
  ]

  async checkAuth(): Promise<AuthResult> {
    try {
      // 搜狐号 v4 使用 /account/listV2，分组字段为 accountInfos。
      // 同时保留旧 accounts 字段兼容，避免旧会话切换期间误判未登录。
      const response = await this.runtime.fetch(
        `https://mp.sohu.com/mpbp/bp/account/listV2?_=${Date.now()}`,
        {
          method: 'GET',
          credentials: 'include',
        }
      )

      // 搜狐子账号 ID 可能超过 JS 安全整数范围；response.json() 会把它静默
      // 舍入成错误值，随后保存接口报「账号不存在」。先取文本，把 15 位以上
      // 的数字 id 字面量保真为字符串再解析。
      const rawText = await response.text()
      const res = JSON.parse(rawText.replace(/("(?:id|accountId)"\s*:\s*)(\d{15,})/g, '$1"$2"')) as {
        code: number
        data?: {
          data?: Array<{
            accountInfos?: SohuAccountInfo[]
            accounts?: SohuAccountInfo[]
          }>
        }
      }

      logger.debug('checkAuth response:', res)

      if (Number(res.code) !== 2000000 || !Array.isArray(res.data?.data)) {
        return { isAuthenticated: false }
      }

      // 收集所有子账号
      const allAccounts: SohuAccountInfo[] = []
      for (const group of res.data.data) {
        const accounts = group.accountInfos || group.accounts || []
        if (Array.isArray(accounts)) allAccounts.push(...accounts)
      }

      if (allAccounts.length === 0) {
        return { isAuthenticated: false }
      }

      // 优先使用搜狐页面当前选中的子账号；没有打开页面时才回退到第一项。
      this.accountInfo = await this.getSelectedPageAccount(allAccounts) || allAccounts[0]
      logger.info(`Using account: ${this.accountInfo.nickName} (id: ${this.accountInfo.id})` +
        (allAccounts.length > 1 ? `, ${allAccounts.length} sub-accounts available` : ''))

      // 获取 mp-cv cookie 用于 sp-cm header
      await this.fetchSpCm()

      // 如果有多个子账号，在用户名中标注
      const displayName = allAccounts.length > 1
        ? `${this.accountInfo.nickName} (共${allAccounts.length}个子账号)`
        : this.accountInfo.nickName

      return {
        isAuthenticated: true,
        userId: String(this.accountInfo.id),
        username: displayName,
        avatar: this.accountInfo.avatar,
      }
    } catch (error) {
      logger.debug('checkAuth: not logged in -', error)
      return { isAuthenticated: false, error: (error as Error).message }
    }
  }

  /**
   * 获取 sp-cm 值 (从 cookie 或生成)
   */
  private async fetchSpCm(): Promise<void> {
    try {
      // 尝试通过 runtime 获取 cookie（如果支持）
      if (this.runtime.getCookie) {
        const cookieValue = await this.runtime.getCookie('.sohu.com', 'mp-cv')
        if (cookieValue) {
          this.spCm = cookieValue
          logger.debug('Got sp-cm from current extension session')
          return
        }
      }
      // fallback: 生成一个
      this.spCm = `100-${Date.now()}-${generateDeviceId()}`
      logger.debug('Generated fallback sp-cm')
    } catch (error) {
      // fallback: 生成一个
      this.spCm = `100-${Date.now()}-${generateDeviceId()}`
      logger.debug('Generated fallback sp-cm after cookie lookup failure')
    }
  }

  async publish(_article: Article, _options?: PublishOptions): Promise<SyncResult> {
    throw new Error('搜狐公开发布已禁用；仅允许通过受保护的 saveDraft 工作流保存草稿')
  }

  async saveDraft(article: Article, options?: PublishOptions): Promise<SyncResult> {
    return this.withHeaderRules(this.HEADER_RULES, async () => {
      const authorization = options?.draftAuthorization
      if (authorization?.action !== 'saveDraft'
        || authorization.platform !== 'sohu'
        || !/^tsk_[0-9]+_[0-9a-f]{8}$/.test(authorization.taskId || '')
        || !/^snap-[0-9a-f]{24}$/.test(authorization.snapshotId || '')) {
        throw new Error('搜狐 saveDraft 缺少本地服务签发的任务/快照授权')
      }
      logger.info('Starting guarded draft save...')
      await options?.onDraftStage?.('running')

      // 1. 确保已登录
      if (!this.accountInfo) {
        const auth = await this.checkAuth()
        if (!auth.isAuthenticated) {
          throw new Error('请先登录搜狐号')
        }
      }

      // 发布包 HTML 是唯一正文来源。图注固定来自 HTML img.alt。
      const canonical = normalizeSohuDraftArticle(parseCanonicalArticle(article.html || '', article.title), article.title)
      if (!canonical.blocks.length) throw new Error('发布包 HTML 没有可保存的正文块')
      assertCaptionPolicy(canonical)
      let content = withSohuNativeImageCaptions(renderCanonicalArticle(canonical))

      // Process images
      await options?.onDraftStage?.('uploading')
      content = await this.processImages(
        content,
        (src) => this.uploadImageByUrl(src),
        {
          skipPatterns: ['sohu.com'],
          onProgress: options?.onImageProgress,
        }
      )

      // 4. 保存草稿 (v2 API - JSON 格式)
      await options?.onDraftStage?.('filling')
      const postData = {
        title: article.title,
        brief: '',
        content: content,
        channelId: 24,
        categoryId: -1,
        id: 0,
        userColumnId: 0,
        columnNewsIds: [],
        businessCode: 0,
        declareOriginal: false,
        cover: '',
        topicIds: [],
        isAd: 0,
        userLabels: '[]',
        reprint: false,
        customTags: '',
        infoResource: 0,
        sourceUrl: '',
        visibleToLoginedUsers: 0,
        attrIds: [],
        auto: true,
        // 搜狐账号 ID 必须原样保留。转换成 Number 可能让长 ID 精度丢失，
        // 并导致页面已保存而接口回读提示“账号不存在”。
        accountId: String(this.accountInfo!.id),
      }

      await options?.onDraftStage?.('saving_draft')
      const response = await this.runtime.fetch(
        `https://mp.sohu.com/mpbp/bp/news/v4/news/draft/v2?accountId=${this.accountInfo!.id}`,
        {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
            'X-Requested-With': 'XMLHttpRequest',
            'dv-id': this.deviceId,
            'sp-cm': this.spCm,
          },
          body: JSON.stringify(postData),
        }
      )

      const res = await response.json() as {
        success?: boolean
        code?: number
        data?: string | number | { id?: string | number; newsId?: string | number }
        msg?: string
      }

      logger.debug(' Save response:', res)

      const rawPostId = typeof res.data === 'object' && res.data
        ? (res.data.id ?? res.data.newsId)
        : res.data
      const postId = String(rawPostId || '')
      const saveCodeAccepted = res.success === true || [1, 100, 200, 2000, 2000000].includes(Number(res.code))
      if (!saveCodeAccepted) {
        // 附上本次使用的子账号与原始响应（截断），区分「ID 精度/子账号选错」
        // 与平台误报——实测该报错出现时草稿可能已实际写入草稿箱。
        const account = this.accountInfo!
        const rawSnippet = JSON.stringify(res).slice(0, 200)
        throw new Error(`${res.msg || '保存失败'}（子账号：${account.nickName}，ID 尾号 ${String(account.id).slice(-6)}；响应：${rawSnippet}）。搜狐接口如此返回时草稿可能已保存，请先到搜狐号后台草稿箱核对，避免重复保存。`)
      }
      if (!/^[0-9]+$/.test(postId)) throw new Error('搜狐保存草稿响应缺少有效草稿 ID')

      // 保存后必须从搜狐草稿详情接口回读；仅收到 ID 不算成功。
      // 回读同样带上本次子账号 ID，保持与保存请求一致的账号上下文。
      const readBackResponse = await this.runtime.fetch(
        `https://mp.sohu.com/mpbp/bp/news/v4/article?newsId=${postId}&accountId=${this.accountInfo!.id}`,
        {
          method: 'GET',
          credentials: 'include',
          headers: {
            'X-Requested-With': 'XMLHttpRequest',
            'dv-id': this.deviceId,
            'sp-cm': this.spCm,
          },
        }
      )
      if (!readBackResponse.ok) throw new Error(`搜狐草稿回读失败: ${readBackResponse.status}`)
      const readBackEnvelope = await readBackResponse.json() as {
        code?: number
        success?: boolean
        msg?: string
        data?: { news?: { id?: string | number; title?: string; content?: string }; id?: string | number; title?: string; content?: string }
      }
      const readBack = readBackEnvelope.data?.news || readBackEnvelope.data || {}
      const readBackMatches = String(readBack.id || '') === postId && Boolean(String(readBack.content || '').trim())
      // 搜狐当前内容管理微前端直接以 data.news/data 为准；不同网关可能
      // 返回 2000 或 2000000。只有精确匹配本次草稿 ID 且正文非空才放行，
      // 因而无需依赖易变的业务成功码，也不会把失败包误判为成功。
      if (!readBackMatches && (readBackEnvelope.success === false
        || (readBackEnvelope.code !== undefined && ![2000, 2000000].includes(readBackEnvelope.code)))) {
        const rawSnippet = JSON.stringify(readBackEnvelope).slice(0, 200)
        throw new Error(`${readBackEnvelope.msg || `搜狐草稿回读接口返回失败（code ${readBackEnvelope.code ?? 'unknown'}）`}（子账号：${this.accountInfo!.nickName}；响应：${rawSnippet}）。注意：保存接口已接受，草稿可能已在草稿箱中，请先人工核对。`)
      }
      if (!readBackMatches) {
        throw new Error('搜狐草稿回读内容与本次保存不一致')
      }

      const draftUrl = `https://mp.sohu.com/mpfe/v4/contentManagement/news/addarticle?spm=smmp.articlelist.0.0&contentStatus=2&id=${postId}`
      // 保存时正文已去掉与标题重复的首块；校验两侧对称处理后再比对。
      const sourceForCheck = normalizeSohuDraftArticle(parseCanonicalArticle(article.html || '', article.title), article.title)
      const readBackForCheck = parseCanonicalArticle(String(readBack.content || ''), String(readBack.title || ''))
      stripDuplicateTitleBlock(readBackForCheck, String(readBack.title || ''))
      const fidelityReport = validateSohuFidelity(sourceForCheck, renderCanonicalArticle(readBackForCheck), String(readBack.title || ''))
      fidelityReport.checks.push(
        { key: 'trusted-draft-url', status: 'PASS', required: true, detail: '搜狐号 HTTPS 编辑草稿 URL' },
        { key: 'draft-only', status: 'PASS', required: true, detail: '仅调用保存草稿接口，未调用公开发布' },
        { key: 'read-back-verified', status: 'PASS', required: true, detail: '已从搜狐号草稿详情接口回读' },
      )
      fidelityReport.summary.pass += 3

      return this.createResult(true, {
        postId,
        postUrl: draftUrl,
        draftOnly: options?.draftOnly ?? true,
        readBackVerified: true,
        fidelityVerified: fidelityReport.fidelityVerified,
        fidelityReport,
      })
    }).catch((error) => this.createResult(false, {
      // 附带抛出点堆栈，用于定位“账号不存在”这类裸平台错误的来源。
      error: `${(error as Error).message}【at ${(error as Error).stack?.split('\n').slice(1, 3).map((line) => line.trim().slice(0, 100)).join(' <= ') || 'unknown'}】`,
    }))
  }

  /**
   * 通过 URL 上传图片
   */
  protected async uploadImageByUrl(src: string): Promise<ImageUploadResult> {
    if (!this.accountInfo) {
      throw new Error('未登录')
    }

    // 1. 下载图片
    const imageResponse = await fetch(src)
    if (!imageResponse.ok) {
      throw new Error('图片下载失败: ' + src)
    }
    const imageBlob = await imageResponse.blob()

    // 2. 上传到搜狐
    const formData = new FormData()
    formData.append('file', imageBlob, 'image.jpg')
    formData.append('accountId', this.accountInfo.id)

    const uploadResponse = await this.runtime.fetch(
      'https://mp.sohu.com/commons/front/outerUpload/image/file?accountId='+  this.accountInfo.id,
      {
        method: 'POST',
        credentials: 'include',
        body: formData,
      }
    )

    const res = await uploadResponse.json() as {
      url?: string
      msg?: string
    }

    logger.debug(' Image upload response:', res)
    if (!res.url) {
      throw new Error('图片上传失败:'+ (res.msg))
    }

    return {
      url: res.url,
    }
  }
}
