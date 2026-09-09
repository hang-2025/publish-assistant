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

const logger = createLogger('Sohu')

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
    homepage: 'https://mp.sohu.com/mpfe/v3/main/first/page?newsType=1',
    capabilities: ['article', 'draft', 'image_upload'],
  }

  /** 预处理配置: 搜狐号使用 HTML 格式 */
  readonly preprocessConfig = {
    outputFormat: 'html' as const,
  }

  private accountInfo: SohuAccountInfo | null = null
  private deviceId: string = generateDeviceId()
  private spCm: string = ''

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
      // 使用 /account/list 获取所有子账号（搜狐号支持多个子账号）
      const response = await this.runtime.fetch(
        `https://mp.sohu.com/mpbp/bp/account/list?_=${Date.now()}`,
        {
          method: 'GET',
          credentials: 'include',
        }
      )

      const res = await response.json() as {
        code: number
        data?: {
          data?: Array<{
            accounts: SohuAccountInfo[]
          }>
        }
      }

      logger.debug('checkAuth response:', res)

      if (res.code !== 2000000 || !res.data?.data?.[0]?.accounts?.length) {
        return { isAuthenticated: false }
      }

      // 收集所有子账号
      const allAccounts: SohuAccountInfo[] = []
      for (const group of res.data.data) {
        if (group.accounts) {
          allAccounts.push(...group.accounts)
        }
      }

      if (allAccounts.length === 0) {
        return { isAuthenticated: false }
      }

      // 默认使用第一个子账号
      this.accountInfo = allAccounts[0]
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
      const canonical = parseCanonicalArticle(article.html || '', article.title)
      if (!canonical.blocks.length) throw new Error('发布包 HTML 没有可保存的正文块')
      assertCaptionPolicy(canonical)
      let content = renderCanonicalArticle(canonical)

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
        accountId: Number(this.accountInfo!.id),
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
        data?: string | number
        msg?: string
      }

      logger.debug(' Save response:', res)

      if (res.success !== true && res.code !== 2000000) {
        throw new Error(res.msg || '保存失败')
      }

      const postId = String(res.data || '')
      if (!/^[0-9]+$/.test(postId)) throw new Error('搜狐保存草稿响应缺少有效草稿 ID')

      // 保存后必须从搜狐草稿详情接口回读；仅收到 ID 不算成功。
      const readBackResponse = await this.runtime.fetch(
        `https://mp.sohu.com/mpbp/bp/news/v4/article?newsId=${postId}`,
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
        data?: { news?: { id?: string | number; title?: string; content?: string }; id?: string | number; title?: string; content?: string }
      }
      if (readBackEnvelope.code !== undefined && readBackEnvelope.code !== 2000000) {
        throw new Error('搜狐草稿回读接口返回失败')
      }
      const readBack = readBackEnvelope.data?.news || readBackEnvelope.data || {}
      if (String(readBack.id || '') !== postId || !String(readBack.content || '').trim()) {
        throw new Error('搜狐草稿回读内容与本次保存不一致')
      }

      const draftUrl = `https://mp.sohu.com/mpfe/v4/contentManagement/news/addarticle?spm=smmp.articlelist.0.0&contentStatus=2&id=${postId}`
      const fidelityReport = validateCanonicalFidelity(canonical, String(readBack.content || ''), String(readBack.title || ''))
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
      error: (error as Error).message,
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
