/**
 * 知乎适配器
 */
import { CodeAdapter, type ImageUploadResult } from '../code-adapter'
import type { Article, AuthResult, SyncResult, PlatformMeta } from '../../types'
import type { PublishOptions } from '../types'
import { createLogger } from '../../lib/logger'
import md5Lib from 'js-md5'
import {
  assertCaptionPolicy,
  parseCanonicalArticle,
  renderCanonicalArticle,
  validateCanonicalFidelity,
} from '../../article/canonical'

const logger = createLogger('Zhihu')

// js-md5 导出的是函数本身
const jsMd5 = md5Lib as unknown as (message: string | ArrayBuffer | Uint8Array) => string

export class ZhihuAdapter extends CodeAdapter {
  readonly meta: PlatformMeta = {
    id: 'zhihu',
    name: '知乎',
    icon: 'https://static.zhihu.com/static/favicon.ico',
    homepage: 'https://www.zhihu.com',
    capabilities: ['article', 'draft', 'image_upload', 'tags', 'cover'],
  }

  /** 预处理配置: 知乎使用 HTML，需要特殊处理 */
  readonly preprocessConfig = {
    outputFormat: 'html' as const,
    // doPreFilter: 移除特殊标签及其父元素
    removeSpecialTags: true,
    removeSpecialTagsWithParent: true,
    // processDocCode: 处理代码块
    processCodeBlocks: true,
    convertSectionToDiv: true,
    removeTrailingBr: true,
    unwrapSingleChildContainers: true,
    unwrapNestedFigures: true,
    compactHtml: true,
    // 清理空内容（与旧 processHtml 一致）
    removeEmptyLines: true,
    removeEmptyDivs: true,
    removeNestedEmptyContainers: true,
  }

  /** 知乎 API 需要的 Header 规则 */
  private readonly HEADER_RULES = [
    {
      urlFilter: '*://www.zhihu.com/api/*',
      headers: { 'x-requested-with': 'fetch' },
      resourceTypes: ['xmlhttprequest'],
    },
    {
      urlFilter: '*://zhuanlan.zhihu.com/api/*',
      headers: { 'x-requested-with': 'fetch' },
      resourceTypes: ['xmlhttprequest'],
    },
    {
      urlFilter: '*://api.zhihu.com/*',
      headers: { 'x-requested-with': 'fetch' },
      resourceTypes: ['xmlhttprequest'],
    },
  ]

  async checkAuth(): Promise<AuthResult> {
    try {
      const response = await this.runtime.fetch('https://www.zhihu.com/api/v4/me', {
        method: 'GET',
        credentials: 'include',
        headers: {
          'x-requested-with': 'fetch',
        },
      })

      const data = await response.json() as {
        id?: string
        name?: string
        avatar_url?: string
      }

      if (data.id) {
        return {
          isAuthenticated: true,
          userId: data.id,
          username: data.name,
          avatar: data.avatar_url,
        }
      }

      return { isAuthenticated: false }
    } catch (error) {
      logger.debug('checkAuth: not logged in -', error)
      return { isAuthenticated: false, error: (error as Error).message }
    }
  }

  async publish(_article: Article, _options?: PublishOptions): Promise<SyncResult> {
    throw new Error('知乎公开发布已禁用；仅允许通过受保护的 saveDraft 工作流保存草稿')
  }

  async saveDraft(article: Article, options?: PublishOptions): Promise<SyncResult> {
    return this.withHeaderRules(this.HEADER_RULES, async () => {
      const authorization = options?.draftAuthorization
      if (authorization?.action !== 'saveDraft'
        || authorization.platform !== 'zhihu'
        || !/^tsk_[0-9]+_[0-9a-f]{8}$/.test(authorization.taskId || '')
        || !/^snap-[0-9a-f]{24}$/.test(authorization.snapshotId || '')) {
        throw new Error('知乎 saveDraft 缺少本地服务签发的任务/快照授权')
      }
      logger.info('Starting guarded draft save...')
      await options?.onDraftStage?.('running')

      // The publishing-package HTML is the canonical source. Do not fall back to
      // Markdown/Word or couple the platform adapter to arbitrary source DOM.
      const canonical = parseCanonicalArticle(article.html || '', article.title)
      if (!canonical.blocks.length) throw new Error('发布包 HTML 没有可保存的正文块')
      assertCaptionPolicy(canonical)

      // 1. 创建草稿
      const createResponse = await this.runtime.fetch('https://zhuanlan.zhihu.com/api/articles/drafts', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'x-requested-with': 'fetch',
        },
        body: JSON.stringify({
          title: article.title,
          content: '',
          delta_time: 0,
        }),
      })

      // 检查响应状态和内容
      const responseText = await createResponse.text()
      logger.debug('Create draft response:', createResponse.status, responseText.substring(0, 200))

      if (!createResponse.ok) {
        throw new Error(`创建草稿失败: ${createResponse.status} - ${responseText}`)
      }

      // 尝试解析 JSON
      let createData: { id?: string }
      try {
        createData = JSON.parse(responseText)
      } catch {
        throw new Error(`创建草稿失败: 响应不是有效 JSON - ${responseText.substring(0, 100)}`)
      }

      if (!createData.id) {
        throw new Error('创建草稿失败: 无效响应')
      }

      const draftId = createData.id
      logger.debug('Draft created:', draftId)

      // 2. 使用预处理好的 HTML（Content Script 已处理代码块、图片、特殊标签等）
      // 知乎使用 HTML 格式
      let content = renderCanonicalArticle(canonical)

      // 3. 处理图片（section → div 转换已在 preprocessConfig 中处理）
      await options?.onDraftStage?.('uploading')
      content = await this.processImages(
        content,
        (src) => this.uploadImageByUrl(src),
        {
          skipPatterns: ['zhimg.com', 'pic1.zhimg.com', 'pic2.zhimg.com', 'pic3.zhimg.com', 'pic4.zhimg.com'],
          onProgress: options?.onImageProgress,
        }
      )

      // 4. 知乎特定的内容转换
      await options?.onDraftStage?.('filling')
      content = this.transformContent(content)

      // 5. 更新草稿内容
      await options?.onDraftStage?.('saving_draft')
      const updateResponse = await this.runtime.fetch(
        `https://zhuanlan.zhihu.com/api/articles/${draftId}/draft`,
        {
          method: 'PATCH',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
            'x-requested-with': 'fetch',
          },
          body: JSON.stringify({
            title: article.title,
            content: content,
          }),
        }
      )

      // 检查更新响应 (PATCH 可能返回空响应或 204)
      if (!updateResponse.ok) {
        const updateText = await updateResponse.text()
        logger.error('Update draft failed:', updateResponse.status, updateText)
        throw new Error(`更新草稿失败: ${updateResponse.status}`)
      }

      logger.debug('Draft updated, status:', updateResponse.status)

      // 6. 保存后回读。草稿 ID 存在不等于内容保真通过。
      const readBackResponse = await this.runtime.fetch(
        `https://zhuanlan.zhihu.com/api/articles/${draftId}/draft`,
        { method: 'GET', credentials: 'include', headers: { 'x-requested-with': 'fetch' } }
      )
      if (!readBackResponse.ok) throw new Error(`草稿回读失败: ${readBackResponse.status}`)
      const readBack = await readBackResponse.json() as { id?: string | number; title?: string; content?: string }
      if (String(readBack.id || '') !== String(draftId) || !String(readBack.content || '').trim()) {
        throw new Error('草稿回读内容与本次保存不一致')
      }

      const draftUrl = `https://zhuanlan.zhihu.com/p/${draftId}/edit`
      const fidelityReport = validateCanonicalFidelity(canonical, String(readBack.content || ''), String(readBack.title || ''))
      fidelityReport.checks.push(
        { key: 'trusted-draft-url', status: 'PASS', required: true, detail: '知乎 HTTPS 编辑草稿 URL' },
        { key: 'draft-only', status: 'PASS', required: true, detail: '仅保存草稿，未调用公开发布' },
        { key: 'read-back-verified', status: 'PASS', required: true, detail: '已从平台草稿接口回读' },
      )
      fidelityReport.summary.pass += 3

      return this.createResult(true, {
        postId: draftId,
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
   * 知乎内容转换 - 适配 Draft.js 编辑器格式
   */
  private transformContent(content: string): string {
    let result = content

    // 1. 转换表格格式 - 知乎 Draft.js 编辑器需要特定格式
    result = this.transformTables(result)

    // 2. Canonical renderer 已把图片放入 figure，并按 HTML alt 生成 figcaption。
    // 此处不得再次包裹，否则会破坏图片锚点和回读校验。

    // 3. 代码块格式
    result = result.replace(
      /<pre><code class="language-(\w+)">/gi,
      '<pre lang="$1"><code>'
    )

    // 4. 移除微信样式属性 (但保留知乎的 data-draft-* 属性)
    result = result.replace(/\s*data-(?!draft)[a-z-]+="[^"]*"/gi, '')
    result = result.replace(/\s*style="[^"]*"/gi, '')

    return result
  }

  /**
   * 转换表格为知乎 Draft.js 格式
   */
  private transformTables(html: string): string {
    // 1. 解包 figure 中的 table
    let result = html.replace(
      /<figure[^>]*>\s*(<table[\s\S]*?<\/table>)\s*<\/figure>/gi,
      '$1'
    )

    // 2. 转换 table 结构
    result = result.replace(
      /<table[^>]*>([\s\S]*?)<\/table>/gi,
      (_match, tableContent) => {
        // 提取 thead 中的行
        const theadMatch = tableContent.match(/<thead[^>]*>([\s\S]*?)<\/thead>/i)
        // 提取 tbody 中的行
        const tbodyMatch = tableContent.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/i)

        let headerRows = ''
        let bodyRows = ''

        if (theadMatch) {
          // 处理表头行 - 确保使用 <th>
          headerRows = theadMatch[1]
            .replace(/<td([^>]*)>/gi, '<th$1>')
            .replace(/<\/td>/gi, '</th>')
        }

        if (tbodyMatch) {
          bodyRows = tbodyMatch[1]
        } else {
          // 没有 tbody，整个内容作为 body（排除 thead）
          bodyRows = tableContent
            .replace(/<thead[^>]*>[\s\S]*?<\/thead>/gi, '')
            .replace(/<\/?tbody[^>]*>/gi, '')
        }

        // 如果没有 thead，检查第一行是否全是 th
        if (!theadMatch) {
          const firstRowMatch = bodyRows.match(/<tr[^>]*>([\s\S]*?)<\/tr>/i)
          if (firstRowMatch) {
            const firstRowContent = firstRowMatch[1]
            if (/<th[^>]*>/i.test(firstRowContent) && !/<td[^>]*>/i.test(firstRowContent)) {
              headerRows = firstRowMatch[0]
              bodyRows = bodyRows.replace(firstRowMatch[0], '')
            }
          }
        }

        // 组装知乎格式的表格
        return `<table data-draft-node="block" data-draft-type="table" data-size="normal" data-row-style="normal"><tbody>${headerRows}${bodyRows}</tbody></table>`
      }
    )

    return result
  }

  /**
   * 通过 Blob 上传图片（覆盖基类方法）
   */
  async uploadImage(file: Blob, _filename?: string): Promise<string> {
    return this.uploadImageBinaryInternal(file)
  }

  /**
   * 通过 URL 上传图片
   * 支持远程 URL 和 data URI
   */
  protected async uploadImageByUrl(src: string): Promise<ImageUploadResult> {
    // 检测 data URI，使用二进制上传
    if (src.startsWith('data:')) {
      logger.debug('Detected data URI, using binary upload')
      const blob = await fetch(src).then(r => r.blob())
      const url = await this.uploadImageBinaryInternal(blob)
      return { url }
    }

    // 远程 URL 使用知乎 URL 上传 API
    const response = await this.runtime.fetch('https://zhuanlan.zhihu.com/api/uploaded_images', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'x-requested-with': 'fetch',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        url: src,
        source: 'article',
      }),
    })

    const data = await response.json() as { src?: string; hash?: string }

    if (data.src) {
      return { url: data.src }
    }

    throw new Error('图片上传失败')
  }

  /**
   * 上传图片 (二进制方式) - 内部使用
   */
  private async uploadImageBinaryInternal(file: Blob): Promise<string> {
    // 1. 计算图片 hash
    const buffer = await file.arrayBuffer()
    const imageHash = jsMd5(buffer)

    // 2. 请求上传凭证
    const tokenResponse = await this.runtime.fetch('https://api.zhihu.com/images', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        image_hash: imageHash,
        source: 'article',
      }),
    })

    const tokenData = await tokenResponse.json() as {
      upload_file: {
        state: number
        image_id: string
        object_key: string
      }
      upload_token: {
        access_id: string
        access_key: string
        access_token: string
      }
    }
    const uploadFile = tokenData.upload_file

    // 3. 检查图片是否已存在
    if (uploadFile.state === 1) {
      const imgDetail = await this.waitForImageReady(uploadFile.image_id)
      const objectKey = imgDetail.original_hash
      return `https://pic4.zhimg.com/${objectKey}`
    }

    // 4. 上传到 OSS
    const token = tokenData.upload_token
    await this.ossUpload(
      'https://zhihu-pics-upload.zhimg.com',
      uploadFile.object_key,
      file,
      token
    )

    // 5. 处理 GIF 扩展名
    let objectKey = uploadFile.object_key
    if (file.type === 'image/gif') {
      objectKey = objectKey + '.gif'
    }

    return `https://pic4.zhimg.com/${objectKey}`
  }

  /**
   * 等待图片处理完成
   */
  private async waitForImageReady(imageId: string): Promise<{ original_hash: string }> {
    const maxRetries = 10
    for (let i = 0; i < maxRetries; i++) {
      const response = await this.runtime.fetch(`https://api.zhihu.com/images/${imageId}`, {
        credentials: 'include',
      })
      const data = await response.json() as { status?: string; original_hash?: string }

      if (data.status === 'completed' || data.original_hash) {
        return data as { original_hash: string }
      }

      await new Promise(resolve => setTimeout(resolve, 1000))
    }
    throw new Error('Image processing timeout')
  }

  /**
   * OSS 上传 - 手动 V1 签名
   */
  private async ossUpload(
    endpoint: string,
    objectKey: string,
    blob: Blob,
    token: { access_id: string; access_key: string; access_token: string }
  ): Promise<void> {
    const contentType = blob.type || 'application/octet-stream'
    const url = `${endpoint}/${objectKey}`

    // OSS 日期格式 (GMT)
    const ossDate = new Date().toUTCString()
    const ossUserAgent = 'aliyun-sdk-js/6.8.0'

    // 构建 CanonicalizedOSSHeaders (按字母顺序排列，每行以\n结尾)
    const ossHeaders: Record<string, string> = {
      'x-oss-date': ossDate,
      'x-oss-security-token': token.access_token,
      'x-oss-user-agent': ossUserAgent,
    }
    // 按字母顺序排序，每个 header 以 \n 结尾
    const canonicalizedOSSHeaders = Object.keys(ossHeaders)
      .sort()
      .map(key => `${key}:${ossHeaders[key]}`)
      .join('\n')

    // CanonicalizedResource: /bucket/object-key
    // bucket 名是 zhihu-pics (不是 zhihu-pics-upload)
    const bucket = 'zhihu-pics'
    const canonicalizedResource = `/${bucket}/${objectKey}`

    // 构建待签名字符串
    // VERB + "\n" + Content-MD5 + "\n" + Content-Type + "\n" + Date + "\n" + CanonicalizedOSSHeaders + "\n" + CanonicalizedResource
    const stringToSign =
      'PUT\n' +
      '\n' +  // Content-MD5 (空)
      contentType + '\n' +
      ossDate + '\n' +  // Date (与 x-oss-date 相同)
      canonicalizedOSSHeaders + '\n' +
      canonicalizedResource

    // 计算 HMAC-SHA1 签名
    const signature = await this.hmacSha1Base64(token.access_key, stringToSign)
    const authorization = `OSS ${token.access_id}:${signature}`

    logger.debug('OSS stringToSign:', JSON.stringify(stringToSign))
    // Authorization/signature must never be written to extension logs.

    // 添加 header 规则来设置正确的 Origin
    let ruleId: string | undefined
    try {
      if (this.runtime.headerRules) {
        ruleId = await this.runtime.headerRules.add({
          urlFilter: '*://zhihu-pics-upload.zhimg.com/*',
          headers: {
            'Origin': 'https://zhuanlan.zhihu.com',
            'Referer': 'https://zhuanlan.zhihu.com/',
          },
          resourceTypes: ['xmlhttprequest'],
        })
        logger.debug('Added header rule for OSS upload:', ruleId)
      }

      const response = await this.runtime.fetch(url, {
        method: 'PUT',
        headers: {
          'Content-Type': contentType,
          'Authorization': authorization,
          'x-oss-date': ossDate,
          'x-oss-security-token': token.access_token,
          'x-oss-user-agent': 'aliyun-sdk-js/6.8.0',
        },
        body: blob,
      })

      if (!response.ok) {
        const text = await response.text()
        logger.error('OSS upload failed:', response.status, text)
        throw new Error(`OSS upload failed: ${response.status}`)
      }
      logger.debug('OSS upload success')
    } finally {
      // 清理 header 规则
      if (ruleId && this.runtime.headerRules) {
        await this.runtime.headerRules.remove(ruleId)
        logger.debug('Removed header rule:', ruleId)
      }
    }
  }

  /**
   * HMAC-SHA1 签名并返回 Base64 (使用 Web Crypto API)
   */
  private async hmacSha1Base64(key: string, message: string): Promise<string> {
    const encoder = new TextEncoder()
    const keyData = encoder.encode(key)
    const messageData = encoder.encode(message)

    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      keyData,
      { name: 'HMAC', hash: 'SHA-1' },
      false,
      ['sign']
    )

    const signature = await crypto.subtle.sign('HMAC', cryptoKey, messageData)
    return btoa(String.fromCharCode(...new Uint8Array(signature)))
  }
}
