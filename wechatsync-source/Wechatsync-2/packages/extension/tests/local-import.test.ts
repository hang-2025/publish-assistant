import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { importDocument, resolveImage, sanitizeHtml, previewDocument, withoutDuplicateTitle } from '../src/local-import/importer'
import { CodeAdapter } from '../../core/src/adapters/code-adapter'
import { ZhihuAdapter } from '../../core/src/adapters/platforms/zhihu'
import { SohuAdapter } from '../../core/src/adapters/platforms/sohu'
import { ToutiaoAdapter } from '../../core/src/adapters/platforms/toutiao'
import { NeteaseAdapter } from '../../core/src/adapters/platforms/netease'
import { preprocessForMultiplePlatforms } from '../src/lib/content-processor'
import { acceptanceChecksPassed, buildAcceptanceEvidence, EXTENSION_BUILD_ID, serviceCompatibility } from '../src/workbench/acceptance'
import { assertCaptionPolicy, parseCanonicalArticle, renderCanonicalArticle, validateCanonicalFidelity, ZHIHU_CAPTION_POLICY_MAX_LENGTH } from '../../core/src/article/canonical'
const requireCore = createRequire(resolve(process.cwd(), '../core/package.json'))
const JSZip = requireCore('jszip')

function file(name: string, content: string | Uint8Array, path = name, type = '') {
  const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content
  const f = new File([bytes as BlobPart], name, { type })
  Object.defineProperty(f, 'webkitRelativePath', { value: path })
  Object.defineProperty(f, 'arrayBuffer', { value: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) })
  return f
}
const png = () => file('中文 图.png', new Uint8Array([137,80,78,71]), '发布包/配图/中文 图.png', 'image/png')
const draftAuthorization = { action: 'saveDraft' as const, platform: 'zhihu' as const, taskId: 'tsk_12345678_deadbeef', snapshotId: 'snap-aaaaaaaaaaaaaaaaaaaaaaaa' }
const sohuDraftAuthorization = { action: 'saveDraft' as const, platform: 'sohu' as const, taskId: 'tsk_12345678_cafebabe', snapshotId: 'snap-bbbbbbbbbbbbbbbbbbbbbbbb' }
const toutiaoDraftAuthorization = { action: 'saveDraft' as const, platform: 'toutiao' as const, taskId: 'tsk_12345678_abcdef12', snapshotId: 'snap-cccccccccccccccccccccccc' }
const neteaseDraftAuthorization = { action: 'saveDraft' as const, platform: 'netease' as const, taskId: 'tsk_12345678_1234abcd', snapshotId: 'snap-dddddddddddddddddddddddd' }

function zhihuRuntime(fetchImpl: (url: string, options?: RequestInit) => Promise<Response>) {
  return {
    type: 'extension', fetch: fetchImpl,
    cookies: { get: vi.fn(), set: vi.fn(), remove: vi.fn() },
    storage: { get: vi.fn(), set: vi.fn(), remove: vi.fn() },
    session: { get: vi.fn(), set: vi.fn() },
    dom: { parseHTML: vi.fn(), querySelector: vi.fn(), querySelectorAll: vi.fn(), getTextContent: vi.fn(), getInnerHTML: vi.fn() },
  } as any
}

describe('guarded Zhihu draft adapter', () => {
  it('rejects public publish and reports unauthenticated sessions', async () => {
    const adapter = new ZhihuAdapter()
    await adapter.init(zhihuRuntime(async () => new Response('{}', { status: 401 })))
    await expect(adapter.publish({ title: 'x', html: '<p>x</p>', markdown: '' })).rejects.toThrow('公开发布已禁用')
    expect((await adapter.checkAuth()).isAuthenticated).toBe(false)
  })

  it('only succeeds after draft save readback matches', async () => {
    const stages: string[] = []
    const adapter = new ZhihuAdapter()
    await adapter.init(zhihuRuntime(async (url, options) => {
      if (url.endsWith('/api/articles/drafts') && options?.method === 'POST') return new Response(JSON.stringify({ id: '12345' }), { status: 200 })
      if (url.endsWith('/12345/draft') && options?.method === 'PATCH') return new Response(null, { status: 204 })
      if (url.endsWith('/12345/draft') && options?.method === 'GET') return new Response(JSON.stringify({ id: '12345', title: '测试', content: '<p>正文</p>' }), { status: 200 })
      return new Response('{}', { status: 404 })
    }))
    const result = await adapter.saveDraft({ title: '测试', html: '<p>正文</p>', markdown: '' }, { draftOnly: true, draftAuthorization, onDraftStage: (stage) => stages.push(stage) })
    expect(result.success).toBe(true)
    expect(result.draftOnly).toBe(true)
    expect(result.readBackVerified).toBe(true)
    expect(result.fidelityVerified).toBe(true)
    expect(stages).toEqual(['running', 'uploading', 'filling', 'saving_draft'])
  })

  it('does not report success when readback fails', async () => {
    const adapter = new ZhihuAdapter()
    await adapter.init(zhihuRuntime(async (url, options) => {
      if (url.endsWith('/api/articles/drafts')) return new Response(JSON.stringify({ id: '9' }), { status: 200 })
      if (options?.method === 'PATCH') return new Response(null, { status: 204 })
      return new Response('{}', { status: 500 })
    }))
    const result = await adapter.saveDraft({ title: '测试', html: '<p>正文</p>', markdown: '' }, { draftOnly: true, draftAuthorization })
    expect(result.success).toBe(false)
    expect(result.readBackVerified).not.toBe(true)
  })

  it('writes visible Caption from HTML img.alt and verifies it on readback', async () => {
    let patchedContent = ''
    const adapter = new ZhihuAdapter()
    await adapter.init(zhihuRuntime(async (url, options) => {
      if (url.endsWith('/api/articles/drafts') && options?.method === 'POST') return new Response(JSON.stringify({ id: '24680' }), { status: 200 })
      if (url.endsWith('/24680/draft') && options?.method === 'PATCH') {
        patchedContent = JSON.parse(String(options.body)).content
        return new Response(null, { status: 204 })
      }
      if (url.endsWith('/24680/draft') && options?.method === 'GET') return new Response(JSON.stringify({ id: '24680', title: '配图测试', content: patchedContent }), { status: 200 })
      return new Response('{}', { status: 404 })
    }))
    const result = await adapter.saveDraft({ title: '配图测试', html: '<p>前文</p><img src="https://pic4.zhimg.com/test.png" alt="来自 HTML 的图注"><p>后文</p>', markdown: '' }, { draftOnly: true, draftAuthorization })
    expect(patchedContent).toContain('<figure data-size="normal"><img src="https://pic4.zhimg.com/test.png" alt="来自 HTML 的图注" data-caption="来自 HTML 的图注" data-size="normal"></figure>')
    expect(patchedContent).not.toContain('<figcaption>')
    expect(result.fidelityVerified).toBe(true)
    expect(result.fidelityReport?.checks.find((check) => check.key === 'caption-equals-html-alt')?.status).toBe('PASS')
  })

  it('rejects saveDraft without a task-bound local authorization', async () => {
    const adapter = new ZhihuAdapter()
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }))
    await adapter.init(zhihuRuntime(fetchMock))
    const result = await adapter.saveDraft({ title: '测试', html: '<p>正文</p>', markdown: '' }, { draftOnly: true })
    expect(result.success).toBe(false)
    expect(result.error).toContain('任务/快照授权')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('guarded Sohu draft adapter', () => {
  it('rejects public publish and taskless saveDraft', async () => {
    const adapter = new SohuAdapter()
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }))
    await adapter.init(zhihuRuntime(fetchMock))
    await expect(adapter.publish({ title: 'x', html: '<p>x</p>', markdown: '' })).rejects.toThrow('公开发布已禁用')
    const result = await adapter.saveDraft({ title: '测试', html: '<p>正文</p>', markdown: '' }, { draftOnly: true })
    expect(result.success).toBe(false)
    expect(result.error).toContain('任务/快照授权')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('saves one draft and only reports success after Sohu readback matches', async () => {
    const stages: string[] = []
    let savedContent = ''
    const adapter = new SohuAdapter()
    await adapter.init(zhihuRuntime(async (url, options) => {
      if (url.includes('/mpbp/bp/account/list')) return new Response(JSON.stringify({ code: 2000000, data: { data: [{ accounts: [{ id: '88', nickName: '验收号', avatar: '' }] }] } }), { status: 200 })
      if (url.includes('/news/v4/news/draft/v2') && options?.method === 'POST') {
        savedContent = JSON.parse(String(options.body)).content
        return new Response(JSON.stringify({ success: true, data: 24680 }), { status: 200 })
      }
      if (url.includes('/news/v4/article?newsId=24680')) return new Response(JSON.stringify({ code: 2000000, data: { news: { id: 24680, title: '搜狐测试', content: savedContent } } }), { status: 200 })
      return new Response('{}', { status: 404 })
    }))
    const result = await adapter.saveDraft({
      title: '搜狐测试',
      html: '<p>前文</p><img src="https://img.mp.sohu.com/test.png" alt="搜狐图片注释"><p><strong>后文</strong></p>',
      markdown: '',
    }, { draftOnly: true, draftAuthorization: sohuDraftAuthorization, onDraftStage: (stage) => stages.push(stage) })
    expect(result.success).toBe(true)
    expect(result.postUrl).toContain('contentStatus=2&id=24680')
    expect(result.readBackVerified).toBe(true)
    expect(result.fidelityVerified).toBe(true)
    expect(savedContent).toContain('<figcaption>搜狐图片注释</figcaption>')
    expect(stages).toEqual(['running', 'uploading', 'filling', 'saving_draft'])
  })

  it('does not report success when the saved content cannot be read back', async () => {
    const adapter = new SohuAdapter()
    await adapter.init(zhihuRuntime(async (url) => {
      if (url.includes('/mpbp/bp/account/list')) return new Response(JSON.stringify({ code: 2000000, data: { data: [{ accounts: [{ id: '88', nickName: '验收号', avatar: '' }] }] } }), { status: 200 })
      if (url.includes('/news/v4/news/draft/v2')) return new Response(JSON.stringify({ success: true, data: 9 }), { status: 200 })
      return new Response('{}', { status: 500 })
    }))
    const result = await adapter.saveDraft({ title: '搜狐测试', html: '<p>正文</p>', markdown: '' }, { draftOnly: true, draftAuthorization: sohuDraftAuthorization })
    expect(result.success).toBe(false)
    expect(result.readBackVerified).not.toBe(true)
  })
})

describe('guarded Toutiao draft adapter', () => {
  it('rejects public publish and taskless saveDraft before touching the platform', async () => {
    const adapter = new ToutiaoAdapter()
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }))
    const runtime = zhihuRuntime(fetchMock)
    runtime.tabs = { query: vi.fn(), create: vi.fn(), waitForLoad: vi.fn(), executeScript: vi.fn() }
    await adapter.init(runtime)
    await expect(adapter.publish({ title: 'x', html: '<p>x</p>', markdown: '' })).rejects.toThrow('公开发布已禁用')
    const result = await adapter.saveDraft({ title: '测试', html: '<p>正文</p>', markdown: '' }, { draftOnly: true })
    expect(result.success).toBe(false)
    expect(result.error).toContain('任务/快照授权')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(runtime.tabs.executeScript).not.toHaveBeenCalled()
  })

  it('uses only save=0, preserves image descriptions and verifies the saved draft by readback', async () => {
    const stages: string[] = []
    let savedForm: Record<string, string> = {}
    let savedContent = ''
    const adapter = new ToutiaoAdapter()
    const runtime = zhihuRuntime(async (url) => {
      if (url.includes('/mp/agw/media/get_media_info')) {
        return new Response(JSON.stringify({ data: { user: { id_str: '88', screen_name: '头条验收号' } } }), { status: 200 })
      }
      return new Response('{}', { status: 404 })
    })
    runtime.tabs = {
      query: vi.fn(async () => [{ id: 7, url: 'https://mp.toutiao.com/profile_v4/graphic/publish' }]),
      create: vi.fn(),
      waitForLoad: vi.fn(),
      executeScript: vi.fn(async (_tabId: number, _func: unknown, args: any[]) => {
        const request = args[0]
        if (request.imageSource) return { ok: true, status: 200, text: JSON.stringify({ code: 0, data: { url: '//p1.toutiaoimg.com/origin/test', web_uri: 'pgc-image/test', width: 600, height: 400, mime_type: 'image/jpeg' } }) }
        if (request.url.startsWith('/mp/agw/article/publish')) {
          savedForm = request.form
          savedContent = request.form.content
          return { ok: true, status: 200, text: JSON.stringify({ code: 0, data: { pgc_id: '13579' } }) }
        }
        if (request.url.startsWith('/mp/agw/article/edit')) {
          return { ok: true, status: 200, text: JSON.stringify({ code: 0, data: { pgc_id: '13579', title: '头条测试', content: savedContent } }) }
        }
        return { ok: false, status: 404, text: '{}' }
      }),
    }
    await adapter.init(runtime)
    const result = await adapter.saveDraft({
      title: '头条测试',
      html: '<p>前文</p><img src="data:image/png;base64,iVBORw==" alt="头条图片描述"><p><strong>后文</strong></p>',
      markdown: '',
    }, { draftOnly: true, draftAuthorization: toutiaoDraftAuthorization, onDraftStage: (stage) => stages.push(stage) })

    expect(result.success).toBe(true)
    expect(result.draftOnly).toBe(true)
    expect(result.readBackVerified).toBe(true)
    expect(result.fidelityVerified).toBe(true)
    expect(result.postUrl).toBe('https://mp.toutiao.com/profile_v4/graphic/publish?from=edit&pgc_id=13579')
    expect(savedForm.save).toBe('0')
    expect(savedForm).not.toHaveProperty('save', '1')
    expect(savedContent).toContain('class="pgc-img-caption">头条图片描述</p>')
    expect(savedContent).toContain('web_uri="pgc-image/test"')
    expect(stages).toEqual(['running', 'uploading', 'filling', 'saving_draft'])
  })

  it('does not report success when platform readback fails', async () => {
    const adapter = new ToutiaoAdapter()
    const runtime = zhihuRuntime(async () => new Response(JSON.stringify({ data: { user: { id: '88' } } }), { status: 200 }))
    runtime.tabs = {
      query: vi.fn(async () => [{ id: 7 }]), create: vi.fn(), waitForLoad: vi.fn(),
      executeScript: vi.fn(async (_tabId: number, _func: unknown, args: any[]) => args[0].url.startsWith('/mp/agw/article/publish')
        ? { ok: true, status: 200, text: JSON.stringify({ code: 0, data: { pgc_id: '9' } }) }
        : { ok: false, status: 500, text: '{}' }),
    }
    await adapter.init(runtime)
    const result = await adapter.saveDraft({ title: '头条测试', html: '<p>正文</p>', markdown: '' }, { draftOnly: true, draftAuthorization: toutiaoDraftAuthorization })
    expect(result.success).toBe(false)
    expect(result.readBackVerified).not.toBe(true)
  })
})

describe('guarded NetEase draft adapter', () => {
  it('rejects public publish and taskless saveDraft before touching the platform', async () => {
    const adapter = new NeteaseAdapter()
    const runtime = zhihuRuntime(async () => new Response('{}', { status: 200 }))
    runtime.tabs = { query: vi.fn(), create: vi.fn(), waitForLoad: vi.fn(), executeScript: vi.fn() }
    await adapter.init(runtime)
    await expect(adapter.publish({ title: 'x', html: '<p>x</p>', markdown: '' })).rejects.toThrow('公开发布已禁用')
    const result = await adapter.saveDraft({ title: '网易测试', html: '<p>正文</p>', markdown: '' }, { draftOnly: true })
    expect(result.success).toBe(false)
    expect(result.error).toContain('任务/快照授权')
    expect(runtime.tabs.executeScript).not.toHaveBeenCalled()
  })

  it('uses only operation=saveDraft, keeps image captions and requires guarded readback', async () => {
    const stages: string[] = []
    let savedForm: Record<string, string> = {}
    let savedContent = ''
    const adapter = new NeteaseAdapter()
    const runtime = zhihuRuntime(async () => new Response('{}', { status: 404 }))
    runtime.tabs = {
      query: vi.fn(async () => [{ id: 17, url: 'https://mp.163.com/subscribe_v4/index.html#/article-publish' }]),
      create: vi.fn(), waitForLoad: vi.fn(),
      executeScript: vi.fn(async (_tabId: number, _func: unknown, args: any[]) => {
        const request = args[0]
        if (request.guardian) return { ok: true, status: 200, text: JSON.stringify({ code: 200, token: 'official-guardian-token' }) }
        if (request.url === '/article/postpage.do') return { ok: true, status: 200, text: JSON.stringify({ code: 1, data: { wemediaId: 'media88', mediaName: '网易验收号' } }) }
        if (request.imageSource) return { ok: true, status: 200, text: JSON.stringify({ code: 1, data: { url: '//dingyue.ws.126.net/test.jpg' } }) }
        if (request.url === '/article/status/api/publishV2.do') {
          savedForm = request.form
          savedContent = request.form.content
          return { ok: true, status: 200, text: JSON.stringify({ code: 1, data: 'docId=doc_13579&pkId=9' }) }
        }
        if (request.url.startsWith('/article/editpage.do')) return {
          ok: true, status: 200,
          text: JSON.stringify({ code: 1, data: { post: { docid: 'doc_13579', title: '网易测试', content: savedContent } } }),
        }
        return { ok: false, status: 404, text: '{}' }
      }),
    }
    await adapter.init(runtime)
    const result = await adapter.saveDraft({
      title: '网易测试',
      html: '<p>前文</p><img src="data:image/png;base64,iVBORw==" alt="网易图片说明"><p><strong>后文</strong></p>',
      markdown: '',
    }, { draftOnly: true, draftAuthorization: neteaseDraftAuthorization, onDraftStage: (stage) => stages.push(stage) })

    expect(result.success).toBe(true)
    expect(result.draftOnly).toBe(true)
    expect(result.readBackVerified).toBe(true)
    expect(result.fidelityVerified).toBe(true)
    expect(result.postUrl).toBe('https://mp.163.com/subscribe_v4/index.html#/article-publish/doc_13579')
    expect(savedForm.operation).toBe('saveDraft')
    expect(Object.values(savedForm)).not.toContain('publish')
    expect(savedForm.ursToken).toBe('official-guardian-token')
    expect(savedContent).toContain('<br>网易图片说明</p>')
    expect(savedContent).toContain('https://dingyue.ws.126.net/test.jpg')
    expect(stages).toEqual(['running', 'uploading', 'filling', 'saving_draft'])
  })

  it('stops before saving when the official guardian token is unavailable', async () => {
    const adapter = new NeteaseAdapter()
    const runtime = zhihuRuntime(async () => new Response('{}', { status: 404 }))
    runtime.tabs = {
      query: vi.fn(async () => [{ id: 17 }]), create: vi.fn(), waitForLoad: vi.fn(),
      executeScript: vi.fn(async (_tabId: number, _func: unknown, args: any[]) => {
        const request = args[0]
        if (request.url === '/article/postpage.do') return { ok: true, status: 200, text: JSON.stringify({ code: 1, data: { wemediaId: 'media88' } }) }
        if (request.guardian) return { ok: false, status: 0, text: '{}' }
        throw new Error('save endpoint must not be called')
      }),
    }
    await adapter.init(runtime)
    const result = await adapter.saveDraft({ title: '网易测试', html: '<p>正文</p>', markdown: '' }, { draftOnly: true, draftAuthorization: neteaseDraftAuthorization })
    expect(result.success).toBe(false)
    expect(result.error).toContain('风控令牌不可用')
  })
})

describe('Stage 3 acceptance safety', () => {
  const compatibleHealth = {
    ok: true,
    name: 'yizao-sync-service',
    version: '0.5.0-stage6-netease-draft',
    protocol: { name: 'yizao-local-service', version: 2 },
    build: { packageVersion: 35, id: EXTENSION_BUILD_ID, extensionBuildId: EXTENSION_BUILD_ID },
  }

  it('blocks mismatched service or extension builds', () => {
    expect(serviceCompatibility(compatibleHealth).ok).toBe(true)
    expect(serviceCompatibility({ ...compatibleHealth, version: 'old-service' }).ok).toBe(false)
    expect(serviceCompatibility({ ...compatibleHealth, protocol: { name: 'yizao-local-service', version: 1 } }).ok).toBe(false)
    expect(serviceCompatibility({ ...compatibleHealth, build: { ...compatibleHealth.build, id: 'old-extension' } }).ok).toBe(false)
    expect(serviceCompatibility({ ...compatibleHealth, build: { ...compatibleHealth.build, packageVersion: 2 } }).ok).toBe(false)
  })

  it('requires every preflight acceptance check', () => {
    const keys = ['service', 'token', 'origin', 'version', 'login', 'article', 'snapshot', 'html-fidelity-source', 'draft-gate', 'publish-gate']
    expect(acceptanceChecksPassed(keys.map((key) => ({ key, ok: true })))).toBe(true)
    expect(acceptanceChecksPassed(keys.map((key) => ({ key, ok: key !== 'token' })))).toBe(false)
    expect(acceptanceChecksPassed(keys.filter((key) => key !== 'login').map((key) => ({ key, ok: true })))).toBe(false)
  })

  it('exports only the non-sensitive acceptance evidence allowlist', () => {
    const evidence = buildAcceptanceEvidence({
      timestamp: '2026-09-08T00:00:00.000Z', serviceVersion: compatibleHealth.version,
      protocolName: compatibleHealth.protocol.name, protocolVersion: compatibleHealth.protocol.version,
      extensionVersion: '2.0.9.8', articleId: 'pkg-safe', packageId: 'pkg-safe',
      snapshotId: 'snap-aaaaaaaaaaaaaaaaaaaaaaaa', contentHash: 'b'.repeat(64), imageCount: 1,
      taskId: 'tsk_12345678_deadbeef', postId: '12345', draftUrl: 'https://zhuanlan.zhihu.com/p/12345/edit',
      draftOnly: true, readBackVerified: true, finalTaskStatus: 'waiting_confirmation',
      fidelityVerified: true, fidelityOverall: 'DEGRADED', fidelitySummary: { pass: 11, degraded: 1, unsupported: 0, fail: 0 },
      saveDraftDeniedBeforeConfirmation: true, publishDenied: true,
    })
    const json = JSON.stringify(evidence).toLowerCase()
    const keys: string[] = []
    const collectKeys = (value: unknown) => {
      if (!value || typeof value !== 'object') return
      for (const [key, nested] of Object.entries(value)) { keys.push(key.toLowerCase()); collectKeys(nested) }
    }
    collectKeys(evidence)
    expect(evidence.platform).toBe('zhihu')
    expect(evidence.safetyGates.publicPublishEnabled).toBe(false)
    for (const forbidden of ['title', 'body', 'content', 'cookie', 'token', 'authorization', 'account', 'profile', 'excelpath', 'filepath', 'absolutepath']) expect(keys).not.toContain(forbidden)
    for (const forbiddenValue of ['bearer ', 'c:\\users\\', 'chrome profile']) expect(json).not.toContain(forbiddenValue)
  })
})

describe('canonical publishing HTML fidelity', () => {
  const sourceHtml = '<h1>主标题</h1><p>第一段 <strong>加粗</strong> <a href="https://example.com">链接</a></p><figure><img src="data:image/png;base64,AAAA" alt="现场图一"><figcaption>旧图注</figcaption></figure><h2>小节</h2><ul><li>甲</li><li>乙</li></ul><blockquote>引用</blockquote><table><tbody><tr><td>A</td><td>B</td></tr></tbody></table><img src="data:image/png;base64,BBBB" alt="现场图二"><p>末段</p>'

  it('parses semantic blocks plus image order and anchors from canonical HTML', () => {
    const article = parseCanonicalArticle(sourceHtml, '测试标题')
    expect(article.blocks.map((block) => block.kind)).toEqual(['heading', 'paragraph', 'image', 'heading', 'list', 'quote', 'table', 'image', 'paragraph'])
    expect(article.images.map((image) => [image.order, image.anchor, image.alt, image.captionCandidate])).toEqual([
      [1, 2, '现场图一', '现场图一'], [2, 6, '现场图二', '现场图二'],
    ])
    const rendered = renderCanonicalArticle(article)
    expect(rendered).toContain('<figcaption>现场图一</figcaption>')
    expect(rendered).not.toContain('旧图注')
  })

  it('accepts 140 Unicode characters and blocks 141 without silently truncating', () => {
    expect(ZHIHU_CAPTION_POLICY_MAX_LENGTH).toBe(140)
    const atLimitAlt = '图'.repeat(140)
    const overLimitAlt = '图'.repeat(141)
    expect(() => assertCaptionPolicy(parseCanonicalArticle(`<img src="x" alt="${atLimitAlt}">`, '标题'))).not.toThrow()
    expect(() => assertCaptionPolicy(parseCanonicalArticle(`<img src="x" alt="${overLimitAlt}">`, '标题'))).toThrow('不会静默截断')
  })

  it('blocks image nesting whose anchor cannot be represented safely', () => {
    expect(() => assertCaptionPolicy(parseCanonicalArticle('<p>前文<span><img src="x" alt="嵌套图"></span>后文</p>', '标题'))).toThrow('不能安全保持锚点')
  })

  it('reports PASS, DEGRADED and FAIL with required-policy semantics', () => {
    const source = parseCanonicalArticle(sourceHtml, '测试标题')
    const rendered = renderCanonicalArticle(source)
    expect(validateCanonicalFidelity(source, rendered, '测试标题').overall).toBe('PASS')

    const emphasisFailure = validateCanonicalFidelity(source, rendered.replace('<strong>加粗</strong>', '加粗'), '测试标题')
    expect(emphasisFailure.fidelityVerified).toBe(false)

    for (const changed of [
      rendered.replace('<ul>', '<p>').replace('</ul>', '</p>'),
      rendered.replace('href="https://example.com"', 'href="https://example.net"'),
      rendered.replace(/<table[\s\S]*?<\/table>/, '<p>AB</p>'),
    ]) {
      const degraded = validateCanonicalFidelity(source, changed, '测试标题')
      expect(degraded.overall).toBe('DEGRADED')
      expect(degraded.fidelityVerified).toBe(true)
    }

    for (const changed of [
      rendered.replace(/<figure>[\s\S]*?<\/figure>/, ''),
      rendered.replace(/(<figure>[\s\S]*?<\/figure>)/, '$1$1'),
      rendered.replace('<figcaption>现场图一</figcaption>', '<figcaption>错误图注</figcaption>'),
      rendered.replace(/(<figure>[\s\S]*?<\/figure>)([\s\S]*)(<figure>[\s\S]*?<\/figure>)/, '$3$2$1'),
    ]) {
      const report = validateCanonicalFidelity(source, changed, '测试标题')
      expect(report.overall).toBe('FAIL')
      expect(report.fidelityVerified).toBe(false)
    }
  })

  it('recognizes Toutiao pgc image blocks and visible descriptions on readback', () => {
    const source = parseCanonicalArticle('<p>前文</p><img src="x" alt="头条图注"><p>后文</p>', '头条测试')
    const readBack = '<p>前文</p><div class="pgc-img"><img src="https://p1.toutiaoimg.com/origin/x" alt="头条图注"><p class="pgc-img-caption">头条图注</p></div><p>后文</p>'
    const report = validateCanonicalFidelity(source, readBack, '头条测试')
    expect(report.fidelityVerified).toBe(true)
    expect(report.checks.find((check) => check.key === 'image-anchor')?.status).toBe('PASS')
    expect(report.checks.find((check) => check.key === 'caption-equals-html-alt')?.status).toBe('PASS')
  })

  it('recognizes NetEase image paragraphs and visible descriptions on readback', () => {
    const source = parseCanonicalArticle('<p>前文</p><img src="x" alt="网易图注"><p>后文</p>', '网易测试')
    const readBack = '<p>前文</p><p style="text-align:center"><img src="https://dingyue.ws.126.net/x.jpg" alt="网易图注"><br>网易图注</p><p>后文</p>'
    const report = validateCanonicalFidelity(source, readBack, '网易测试')
    expect(report.fidelityVerified).toBe(true)
    expect(report.checks.find((check) => check.key === 'image-anchor')?.status).toBe('PASS')
    expect(report.checks.find((check) => check.key === 'caption-equals-html-alt')?.status).toBe('PASS')
  })
})

describe('local article import', () => {
  it('loads UTF-8 Markdown and a Chinese percent-encoded relative image, retaining ALT', async () => {
    const md = file('正文.md', '# 雷电预警\n\n第一段\n\n![现场说明](配图/中文%20图.png)\n\n第二段', '发布包/正文.md')
    const a = await importDocument(md, [md, png()])
    expect(a.title).toBe('雷电预警'); expect(a.missing).toEqual([])
    expect(a.imageCount).toBe(1); expect(a.html).toContain('data:image/png;base64,')
    expect(a.html).toContain('alt="现场说明"')
    expect(a.html.indexOf('第一段')).toBeLessThan(a.html.indexOf('<img'))
    expect(a.html.indexOf('<img')).toBeLessThan(a.html.indexOf('第二段'))
  })
  it('keeps headings unless the first heading exactly matches the title', () => {
    expect(withoutDuplicateTitle('<h1>标题</h1><p>内容</p>', '标题')).toBe('<p>内容</p>')
    expect(withoutDuplicateTitle('<h2>小节</h2>', '标题')).toContain('小节')
  })
  it('understands title frontmatter without sending metadata as prose', async () => {
    const md = file('正文.md', '---\ntitle: "文章标题"\n---\n正文')
    const a = await importDocument(md, [md]); expect(a.title).toBe('文章标题'); expect(a.html).not.toContain('title:')
  })
  it('does not guess among duplicate image filenames', () => {
    expect(resolveImage('missing/中文 图.png', '正文.md', [png(), file('中文 图.png','x','其他/中文 图.png')])).toBeUndefined()
  })
  it('resolves exact relative paths before fallback even when filenames repeat', () => {
    const image = png()
    expect(resolveImage('配图/中文 图.png', '发布包/正文.md', [image, file('中文 图.png','x','其他/中文 图.png')])).toBe(image)
  })
  it('reports missing images and never fetches remote URLs in preview', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const md = file('a.md','![缺图](https://example.com/a.png)')
    const a = await importDocument(md,[md]); expect(a.missing).toEqual(['https://example.com/a.png'])
    expect(a.html).not.toContain('src='); expect(fetchSpy).not.toHaveBeenCalled(); fetchSpy.mockRestore()
  })
  it('sanitizes active HTML, tracking resources and unsafe links', () => {
    const h = sanitizeHtml('<script>alert(1)</script><iframe src="https://x"></iframe><p onclick="evil()" style="background:url(https://x)">文字</p><a href="javascript:evil()">a</a><img src="x.png" onerror="evil()">')
    expect(h).not.toMatch(/script|iframe|onclick|onerror|style=|javascript:/)
    expect(previewDocument(h)).toContain("default-src 'none'")
  })
  it('rejects legacy doc and oversize files', async () => {
    await expect(importDocument(file('a.doc','x'),[])).rejects.toThrow('.docx')
    const large = file('a.md','x'); Object.defineProperty(large,'size',{ value: 16*1024*1024 })
    await expect(importDocument(large,[])).rejects.toThrow('15MB')
  })
  it('converts actual DOCX paragraphs and embedded image in order', async () => {
    const z = new JSZip()
    z.file('[Content_Types].xml','<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
    z.file('_rels/.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
    z.file('word/document.xml','<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body><w:p><w:r><w:t>第一段中文</w:t></w:r></w:p><w:p><w:r><w:drawing><wp:inline><wp:docPr id="1" name="配图" descr="现场ALT"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:blipFill><a:blip r:embed="rImg"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p><w:p><w:r><w:t>最后一段</w:t></w:r></w:p></w:body></w:document>')
    z.file('word/_rels/document.xml.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rImg" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image.png"/></Relationships>')
    z.file('word/media/image.png',new Uint8Array([137,80,78,71]))
    const f = file('现场文章.docx', await z.generateAsync({type:'uint8array'}))
    const a = await importDocument(f,[f])
    expect(a.imageCount).toBe(1); expect(a.missing).toEqual([]); expect(a.html).toContain('现场ALT')
    expect(a.html.indexOf('第一段中文')).toBeLessThan(a.html.indexOf('<img'))
    expect(a.html.indexOf('<img')).toBeLessThan(a.html.indexOf('最后一段'))
  })
  it('platform preprocessing retains local embedded images', () => {
    const h = '<p>第一段</p><img src="data:image/png;base64,iVBORw==" alt="现场"><p>第二段</p>'
    const r = preprocessForMultiplePlatforms(h, {sohu:{outputFormat:'html'},zhihu:{outputFormat:'html',compactHtml:true}})
    for (const p of Object.values(r)) { expect(p.html).toContain('data:image/png;base64,iVBORw=='); expect(p.html).toContain('现场') }
  })
})

describe('image upload safety', () => {
  function adapter() { const a = Object.create(CodeAdapter.prototype); a.delay = async () => {}; return a }
  it('retains ALT on upload and uploads duplicate image once', async () => {
    const upload = vi.fn(async () => ({url:'https://cdn.example/image.png'}))
    const html = '<img src="data:image/png;base64,AAAA" alt="中文ALT" width="600"><img src="data:image/png;base64,AAAA" alt="第二图">'
    const result = await adapter().processImages(html,upload)
    expect(result).toContain('alt="中文ALT"'); expect(result).toContain('alt="第二图"'); expect(upload).toHaveBeenCalledTimes(1)
  })
  it('throws on upload failure rather than saving an incomplete article', async () => {
    await expect(adapter().processImages('<img src="data:image/png;base64,AAAA">',async () => { throw new Error('上传失败') })).rejects.toThrow('已停止保存文章')
  })
})
