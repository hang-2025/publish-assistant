/**
 * CSDN 适配器
 */
import { CodeAdapter, type ImageUploadResult } from '../code-adapter'
import type { Article, AuthResult, SyncResult, PlatformMeta } from '../../types'
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

const logger = createLogger('CSDN')

interface CSDNUserInfo {
  csdnid: string
  username: string
  avatarurl: string
}

export class CSDNAdapter extends CodeAdapter {
  readonly meta: PlatformMeta = {
    id: 'csdn',
    name: 'CSDN',
    icon: 'https://g.csdnimg.cn/static/logo/favicon32.ico',
    homepage: 'https://editor.csdn.net/md/',
    capabilities: ['article', 'draft', 'image_upload'],
  }

  /** 预处理配置: CSDN 使用 Markdown 格式 */
  readonly preprocessConfig = {
    outputFormat: 'markdown' as const,
  }

  private userInfo: CSDNUserInfo | null = null

  // CSDN API 签名密钥
  private readonly API_KEY = '203803574'
  private readonly API_SECRET = '9znpamsyl2c7cdrr9sas0le9vbc3r6ba'

  /** CSDN API 需要的 Header 规则 */
  private readonly HEADER_RULES = [
    {
      urlFilter: '*://bizapi.csdn.net/*',
      headers: {
        'Origin': 'https://editor.csdn.net',
        'Referer': 'https://editor.csdn.net/',
      },
      resourceTypes: ['xmlhttprequest'],
    },
    {
      urlFilter: '*://imgservice.csdn.net/*',
      headers: {
        'Origin': 'https://editor.csdn.net',
        'Referer': 'https://editor.csdn.net/',
      },
      resourceTypes: ['xmlhttprequest'],
    },
    {
      urlFilter: '*://csdn-img-blog.obs.cn-north-4.myhuaweicloud.com/*',
      headers: {
        'Origin': 'https://editor.csdn.net',
        'Referer': 'https://editor.csdn.net/',
      },
      resourceTypes: ['xmlhttprequest'],
    },
  ]

  async checkAuth(): Promise<AuthResult> {
    try {
      // 使用带签名的 API
      const apiPath = '/blog-console-api/v3/editor/getBaseInfo'
      const headers = await this.signRequest(apiPath, 'GET')

      const response = await this.runtime.fetch(
        `https://bizapi.csdn.net${apiPath}`,
        {
          method: 'GET',
          credentials: 'include',
          headers,
        }
      )

      const res = await response.json() as {
        code: number
        data?: {
          name: string
          nickname: string
          avatar: string
          blog_url: string
        }
      }

      logger.debug('checkAuth response:', res)

      if (res.code === 200 && res.data?.name) {
        this.userInfo = {
          csdnid: res.data.name,
          username: res.data.nickname || res.data.name,
          avatarurl: res.data.avatar,
        }
        return {
          isAuthenticated: true,
          userId: res.data.name,
          username: res.data.nickname || res.data.name,
          avatar: res.data.avatar,
        }
      }

      return { isAuthenticated: false }
    } catch (error) {
      logger.debug('checkAuth: not logged in -', error)
      return { isAuthenticated: false, error: (error as Error).message }
    }
  }

  /**
   * 生成 UUID
   */
  private createUuid(): string {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = Math.random() * 16 | 0
      const v = c === 'x' ? r : (r & 0x3 | 0x8)
      return v.toString(16)
    })
  }

  /**
   * HMAC-SHA256 签名 (使用 Web Crypto API)
   */
  private async hmacSha256(message: string, secret: string): Promise<string> {
    const encoder = new TextEncoder()
    const keyData = encoder.encode(secret)
    const messageData = encoder.encode(message)

    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      keyData,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    )

    const signature = await crypto.subtle.sign('HMAC', cryptoKey, messageData)

    // 转换为 Base64
    const bytes = new Uint8Array(signature)
    let binary = ''
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i])
    }
    return btoa(binary)
  }

  /**
   * 生成 CSDN API 签名
   * 签名格式: METHOD\nAccept\nContent-MD5\nContent-Type\n\nHeaders\nPath
   */
  private async signRequest(apiPath: string, method: 'GET' | 'POST' = 'POST'): Promise<Record<string, string>> {
    const nonce = this.createUuid()

    // GET: 没有 Content-Type，所以那一行为空
    // POST: Content-Type 为 application/json
    const signStr = method === 'GET'
      ? `GET\n*/*\n\n\n\nx-ca-key:${this.API_KEY}\nx-ca-nonce:${nonce}\n${apiPath}`
      : `POST\n*/*\n\napplication/json\n\nx-ca-key:${this.API_KEY}\nx-ca-nonce:${nonce}\n${apiPath}`

    logger.debug('Sign string:', JSON.stringify(signStr))

    const signature = await this.hmacSha256(signStr, this.API_SECRET)

    const headers: Record<string, string> = {
      'accept': '*/*',
      'x-ca-key': this.API_KEY,
      'x-ca-nonce': nonce,
      'x-ca-signature': signature,
      'x-ca-signature-headers': 'x-ca-key,x-ca-nonce',
    }

    if (method === 'POST') {
      headers['content-type'] = 'application/json'
    }

    return headers
  }

  /** 由 canonical 块生成编辑器 Markdown 源；图片 URL 取自已上传的 HTML，避免重复上传。 */
  private renderCanonicalMarkdown(article: ReturnType<typeof parseCanonicalArticle>, imageUrls: string[]): string {
    let imageIndex = 0
    return article.blocks.map((block) => {
      if (block.kind === 'heading') return `${'#'.repeat(Math.min(block.level, 6))} ${block.text}`
      if (block.kind === 'image') {
        const url = imageUrls[imageIndex++] || block.source
        return `![${block.alt}](${url})`
      }
      if (block.kind === 'divider') return '---'
      if (block.kind === 'quote') return block.html
      return 'html' in block && block.html ? block.html : block.text
    }).join('\n\n')
  }

  async saveDraft(article: Article, options?: PublishOptions): Promise<SyncResult> {
    return this.withHeaderRules(this.HEADER_RULES, async () => {
      const authorization = options?.draftAuthorization
      if (authorization?.action !== 'saveDraft' || authorization.platform !== 'csdn'
        || !/^tsk_[0-9]+_[0-9a-f]{8}$/.test(authorization.taskId || '')
        || !/^snap-[0-9a-f]{24}$/.test(authorization.snapshotId || '')) {
        throw new Error('CSDN saveDraft 缺少本地服务签发的任务/快照授权')
      }
      await options?.onDraftStage?.('running')

      if (!this.userInfo) {
        const auth = await this.checkAuth()
        if (!auth.isAuthenticated) throw new Error('请先登录 CSDN')
      }

      // 发布包 HTML 是唯一正文来源；图注固定来自 HTML img.alt。
      const canonical = parseCanonicalArticle(article.html || '', article.title)
      if (!canonical.blocks.length) throw new Error('发布包 HTML 没有可保存的正文块')
      assertCaptionPolicy(canonical)
      stripDuplicateTitleBlock(canonical, article.title)

      await options?.onDraftStage?.('uploading')
      const htmlContent = await this.processImages(
        renderCanonicalArticle(canonical),
        (src) => this.uploadImageByUrl(src),
        {
          skipPatterns: ['csdnimg.cn', 'csdn.net'],
          onProgress: options?.onImageProgress,
        }
      )
      // Markdown 从已上传的 HTML 中按顺序取图片 URL，同一张图只上传一份。
      const { document: urlDoc } = parseHTML(`<!doctype html><html><body>${htmlContent}</body></html>`)
      const imageUrls = Array.from(urlDoc.querySelectorAll('img')).map((img) => img.getAttribute('src') || '')
      const markdownContent = this.renderCanonicalMarkdown(canonical, imageUrls)

      await options?.onDraftStage?.('filling')
      await options?.onDraftStage?.('saving_draft')
      const apiPath = '/blog-console-api/v3/mdeditor/saveArticle'
      const headers = await this.signRequest(apiPath)
      const response = await this.runtime.fetch(
        `https://bizapi.csdn.net${apiPath}`,
        {
          method: 'POST',
          credentials: 'include',
          headers,
          body: JSON.stringify({
            title: article.title,
            markdowncontent: markdownContent,
            content: htmlContent,
            readType: 'public',
            level: 0,
            tags: '',
            status: 2, // 草稿
            categories: '',
            type: 'original',
            original_link: '',
            authorized_status: false,
            not_auto_saved: '1',
            source: 'pc_mdeditor',
            cover_images: [],
            cover_type: 1,
            is_new: 1,
            vote_id: 0,
            resource_id: '',
            pubStatus: 'draft',
            creator_activity_id: '',
          }),
        }
      )

      const res = await response.json() as { code: number; message?: string; msg?: string; data?: { id: string | number } }
      logger.debug('Save response:', res)
      if (res.code !== 200 || !res.data?.id) {
        const rawSnippet = JSON.stringify(res).slice(0, 200)
        throw new Error(`${res.msg || res.message || '保存草稿失败'}（响应：${rawSnippet}）`)
      }
      const postId = String(res.data.id)

      // 保存后必须从编辑器详情接口回读；仅收到 ID 不算成功。
      // 接口与官方编辑器一致：GET /v3/editor/getArticle?id={id}（非 mdeditor 前缀）。
      const getApiPath = `/blog-console-api/v3/editor/getArticle?id=${encodeURIComponent(postId)}`
      const getHeaders = await this.signRequest(getApiPath, 'GET')
      const readBackResponse = await this.runtime.fetch(
        `https://bizapi.csdn.net${getApiPath}`,
        { method: 'GET', credentials: 'include', headers: getHeaders }
      )
      if (!readBackResponse.ok) throw new Error(`CSDN 草稿回读失败: ${readBackResponse.status}`)
      const readBack = await readBackResponse.json() as {
        code: number
        data?: { title?: string; content?: string; markdowncontent?: string }
      }
      const readBackData = readBack?.data
      if (readBack.code !== 200 || !readBackData || !String(readBackData.content || '').trim()) {
        throw new Error(`CSDN 草稿回读接口返回失败（code ${readBack?.code ?? 'unknown'}；响应：${JSON.stringify(readBack).slice(0, 200)}）`)
      }

      // 保存时正文已去掉与标题重复的首块；校验两侧对称处理后再比对。
      const sourceForCheck = parseCanonicalArticle(article.html || '', article.title)
      stripDuplicateTitleBlock(sourceForCheck, article.title)
      const readBackForCheck = parseCanonicalArticle(String(readBackData.content || ''), String(readBackData.title || ''))
      stripDuplicateTitleBlock(readBackForCheck, String(readBackData.title || ''))
      const fidelityReport = validateWithCharOffsetFidelity(sourceForCheck, renderCanonicalArticle(readBackForCheck), String(readBackData.title || ''), 'CSDN')
      fidelityReport.checks.push(
        { key: 'trusted-draft-url', status: 'PASS', required: true, detail: 'CSDN HTTPS 编辑器草稿 URL' },
        { key: 'draft-only', status: 'PASS', required: true, detail: 'status=2/pubStatus=draft 仅保存草稿；未调用公开发布' },
        { key: 'read-back-verified', status: 'PASS', required: true, detail: '已从 CSDN 编辑器详情接口回读' },
      )
      fidelityReport.summary.pass += 3

      return this.createResult(fidelityReport.fidelityVerified, {
        postId,
        postUrl: `https://editor.csdn.net/md?articleId=${postId}`,
        draftOnly: true,
        readBackVerified: true,
        fidelityVerified: fidelityReport.fidelityVerified,
        fidelityReport,
      })
    }).catch((error) => this.createResult(false, {
      error: (error as Error).message,
    }))
  }

  async publish(article: Article, options?: PublishOptions): Promise<SyncResult> {
    return this.withHeaderRules(this.HEADER_RULES, async () => {
      logger.info('Starting publish...')

      // 1. 确保已登录
      if (!this.userInfo) {
        const auth = await this.checkAuth()
        if (!auth.isAuthenticated) {
          throw new Error('请先登录 CSDN')
        }
      }

      // Use pre-processed markdown content directly
      let markdown = article.markdown || ''

      // Process images in markdown
      markdown = await this.processImages(
        markdown,
        (src) => this.uploadImageByUrl(src),
        {
          skipPatterns: ['csdnimg.cn', 'csdn.net'],
          onProgress: options?.onImageProgress,
        }
      )

      // Get HTML content (CSDN API needs both markdown and HTML)
      const htmlContent = article.html || ''

      // Generate signature and save article
      const apiPath = '/blog-console-api/v3/mdeditor/saveArticle'
      const headers = await this.signRequest(apiPath)

      const response = await this.runtime.fetch(
        `https://bizapi.csdn.net${apiPath}`,
        {
          method: 'POST',
          credentials: 'include',
          headers,
          body: JSON.stringify({
            title: article.title,
            markdowncontent: markdown,
            content: htmlContent,
            readType: 'public',
            level: 0,
            tags: '',
            status: 2, // 草稿
            categories: '',
            type: 'original',
            original_link: '',
            authorized_status: false,
            not_auto_saved: '1',
            source: 'pc_mdeditor',
            cover_images: [],
            cover_type: 1,
            is_new: 1,
            vote_id: 0,
            resource_id: '',
            pubStatus: 'draft',
            creator_activity_id: '',
          }),
        }
      )

      const res = await response.json() as {
        code: number
        message?: string
        msg?: string
        data?: { id: string }
      }

      logger.debug('Save response:', res)

      if (res.code !== 200 || !res.data?.id) {
        throw new Error(res.msg || res.message || '保存草稿失败')
      }

      const postId = res.data.id
      const draftUrl = `https://editor.csdn.net/md?articleId=${postId}`

      return this.createResult(true, {
        postId: postId,
        postUrl: draftUrl,
        draftOnly: options?.draftOnly ?? true,
      })
    }).catch((error) => this.createResult(false, {
      error: (error as Error).message,
    }))
  }

  /**
   * 通过 Blob 上传图片（覆盖基类方法）
   * 需要设置动态请求头规则以支持 MCP 调用
   */
  async uploadImage(file: Blob, _filename?: string): Promise<string> {
    return this.withHeaderRules(this.HEADER_RULES, async () => {
      // 转为 data URI 然后调用 uploadImageByUrl
      const dataUri = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(reader.result as string)
        reader.onerror = reject
        reader.readAsDataURL(file)
      })
      const result = await this.uploadImageByUrl(dataUri)
      return result.url
    })
  }

  /**
   * 通过 URL 上传图片
   */
  protected async uploadImageByUrl(src: string): Promise<ImageUploadResult> {
    // 1. 下载图片
    const imageResponse = await fetch(src)
    if (!imageResponse.ok) {
      throw new Error('图片下载失败: ' + src)
    }
    const imageBlob = await imageResponse.blob()

    // 2. 获取文件扩展名
    const ext = src.split('.').pop()?.toLowerCase()?.split('?')[0] || 'jpg'
    const validExt = ['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext) ? ext : 'jpg'

    // 3. 获取上传签名 (新 API: bizapi.csdn.net)
    const apiPath = '/resource-api/v1/image/direct/upload/signature'
    const headers = await this.signRequest(apiPath, 'POST')

    const signatureRes = await this.runtime.fetch(
      `https://bizapi.csdn.net${apiPath}`,
      {
        method: 'POST',
        credentials: 'include',
        headers,
        body: JSON.stringify({
          imageTemplate: '',
          appName: 'direct_blog_markdown',
          imageSuffix: validExt,
        }),
      }
    )

    const signatureData = await signatureRes.json() as {
      code: number
      data?: {
        filePath: string
        host: string
        accessId: string
        policy: string
        signature: string
        callbackUrl: string
        callbackBody: string
        callbackBodyType: string
        customParam: {
          rtype: string
          filePath: string
          isAudit: number
          'x-image-app': string
          type: string
          'x-image-suffix': string
          username: string
        }
      }
    }

    logger.debug('Upload signature response:', signatureData)

    if (signatureData.code !== 200 || !signatureData.data) {
      logger.warn('Failed to get upload signature, using original URL')
      return { url: src }
    }

    const uploadData = signatureData.data
    const customParam = uploadData.customParam

    // 4. 上传到华为云 OBS
    const formData = new FormData()
    formData.append('key', uploadData.filePath)
    formData.append('policy', uploadData.policy)
    formData.append('signature', uploadData.signature)
    formData.append('callbackBody', uploadData.callbackBody)
    formData.append('callbackBodyType', uploadData.callbackBodyType)
    formData.append('callbackUrl', uploadData.callbackUrl)
    formData.append('AccessKeyId', uploadData.accessId)
    formData.append('x:rtype', customParam.rtype)
    formData.append('x:filePath', customParam.filePath)
    formData.append('x:isAudit', String(customParam.isAudit))
    formData.append('x:x-image-app', customParam['x-image-app'])
    formData.append('x:type', customParam.type)
    formData.append('x:x-image-suffix', customParam['x-image-suffix'])
    formData.append('x:username', customParam.username)
    formData.append('file', imageBlob, `image.${validExt}`)

    const obsResponse = await this.runtime.fetch(uploadData.host, {
      method: 'POST',
      body: formData,
    })

    const obsRes = await obsResponse.json() as {
      code: number
      data?: { imageUrl: string }
    }

    logger.debug('OBS upload response:', obsRes)

    if (obsRes.code !== 200 || !obsRes.data?.imageUrl) {
      logger.warn('OBS upload failed, using original URL')
      return { url: src }
    }

    return {
      url: obsRes.data.imageUrl,
    }
  }
}
