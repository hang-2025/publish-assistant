import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { importDocument, resolveImage, sanitizeHtml, previewDocument, withoutDuplicateTitle } from '../src/local-import/importer'
import { CodeAdapter } from '../../core/src/adapters/code-adapter'
import { ZhihuAdapter } from '../../core/src/adapters/platforms/zhihu'
import { normalizeSohuDraftArticle, SohuAdapter, validateSohuFidelity } from '../../core/src/adapters/platforms/sohu'
import { ToutiaoAdapter } from '../../core/src/adapters/platforms/toutiao'
import { CSDNAdapter } from '../../core/src/adapters/platforms/csdn'
import { NeteaseAdapter, normalizeNeteaseDraftArticle, validateNeteaseFidelity } from '../../core/src/adapters/platforms/netease'
import { normalizeXiaohongshuBodyForComparison, normalizeXiaohongshuDraftArticle, XiaohongshuAdapter } from '../../core/src/adapters/platforms/xiaohongshu'
import { doubanDraftJsonToHtml, DoubanAdapter } from '../../core/src/adapters/platforms/douban'
import { buildDouyinSummary, DouyinAdapter } from '../../core/src/adapters/platforms/douyin'
import { buildDouyinImportDocx } from '../../core/src/adapters/platforms/douyin-docx'
import JSZip from 'jszip'
import { preprocessForMultiplePlatforms } from '../src/lib/content-processor'
import { acceptanceChecksPassed, buildAcceptanceEvidence, EXTENSION_BUILD_ID, serviceCompatibility } from '../src/workbench/acceptance'
import { assertCaptionPolicy, parseCanonicalArticle, renderCanonicalArticle, validateCanonicalFidelity, ZHIHU_CAPTION_POLICY_MAX_LENGTH } from '../../core/src/article/canonical'
import { shouldAutoCheckPlatformAuth } from '../src/adapters/auth-policy'
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
const xiaohongshuDraftAuthorization = { action: 'saveDraft' as const, platform: 'xiaohongshu' as const, taskId: 'tsk_12345678_9876abcd', snapshotId: 'snap-eeeeeeeeeeeeeeeeeeeeeeee' }
const doubanDraftAuthorization = { action: 'saveDraft' as const, platform: 'douban' as const, taskId: 'tsk_12345678_1357ace0', snapshotId: 'snap-ffffffffffffffffffffffff' }
const douyinDraftAuthorization = { action: 'saveDraft' as const, platform: 'douyin' as const, taskId: 'tsk_12345678_2468bdf1', snapshotId: 'snap-121212121212121212121212' }

function doubanPage(noteId = '') {
  return {
    ck: '', noteId, userName: '豆瓣测试用户', avatar: '',
    clues: { pageTitle: '写日记', loginWall: false, ckFrom: 'none', ckSuffix: 'none', noteIdPresent: Boolean(noteId), storageCk: 'none' },
  }
}

describe('guarded Douban draft adapter', () => {
  it('rejoins an IMAGE block and its following caption before fidelity validation', () => {
    const html = doubanDraftJsonToHtml({
      blocks: [
        { key: '0', type: 'unstyled', text: '图片前正文', entityRanges: [] },
        { key: '1', type: 'atomic', text: ' ', entityRanges: [{ offset: 0, length: 1, key: 0 }] },
        { key: '2', type: 'unstyled', text: '盐雾试验图片说明', entityRanges: [] },
        { key: '3', type: 'unstyled', text: '图片后正文', entityRanges: [] },
      ],
      entityMap: { 0: { type: 'IMAGE', data: { src: 'https://img.example/test.jpg' } } },
    })

    expect(html).toContain('<figure>')
    expect(html).toContain('alt="盐雾试验图片说明"')
    expect(html).toContain('<figcaption>盐雾试验图片说明</figcaption>')
    expect(parseCanonicalArticle(html).blocks.filter((block) => block.kind !== 'image').map((block: any) => block.text)).toEqual(['图片前正文', '图片后正文'])
  })

  it('reads the native Douban image description without treating it as body text', () => {
    const html = doubanDraftJsonToHtml({
      blocks: [
        { key: '0', type: 'unstyled', text: '图片前正文', entityRanges: [] },
        { key: '1', type: 'atomic', text: ' ', entityRanges: [{ offset: 0, length: 1, key: 0 }] },
        { key: '2', type: 'unstyled', text: '图片后正文', entityRanges: [] },
      ],
      entityMap: { 0: { type: 'IMAGE', data: { src: 'https://img.example/test.jpg', description: '豆瓣原生图片描述' } } },
    })

    expect(html).toContain('alt="豆瓣原生图片描述"')
    expect(html).toContain('<figcaption>豆瓣原生图片描述</figcaption>')
    expect(parseCanonicalArticle(html).blocks.filter((block) => block.kind !== 'image').map((block: any) => block.text)).toEqual(['图片前正文', '图片后正文'])
  })

  it('reuses only the real note creation page so a preallocated note id is available', async () => {
    const adapter = new DoubanAdapter()
    const runtime = zhihuRuntime(async () => new Response('{}', { status: 404 }))
    runtime.getCookie = vi.fn(async () => 'cookie-ck')
    runtime.tabs = {
      query: vi.fn(async () => [{ id: 31, url: 'https://www.douban.com/topic/create?subtype=note' }]),
      create: vi.fn(), waitForLoad: vi.fn(),
      executeScript: vi.fn()
        .mockResolvedValueOnce(doubanPage('987654321'))
        .mockResolvedValueOnce(''),
    }
    await adapter.init(runtime)

    const auth = await adapter.checkAuth()

    expect(auth.isAuthenticated).toBe(true)
    expect(runtime.tabs.query).toHaveBeenCalledWith('https://www.douban.com/topic/create*')
    expect(runtime.tabs.create).not.toHaveBeenCalled()
  })

  it('opens a fresh note creation page instead of reusing an arbitrary Douban page', async () => {
    const adapter = new DoubanAdapter()
    const runtime = zhihuRuntime(async () => new Response('{}', { status: 404 }))
    runtime.getCookie = vi.fn(async () => 'cookie-ck')
    runtime.tabs = {
      query: vi.fn(async () => []),
      create: vi.fn(async () => ({ id: 32, url: 'https://www.douban.com/topic/create?subtype=note' })),
      waitForLoad: vi.fn(),
      executeScript: vi.fn()
        .mockResolvedValueOnce(doubanPage('987654322'))
        .mockResolvedValueOnce(''),
    }
    await adapter.init(runtime)

    expect((await adapter.checkAuth()).isAuthenticated).toBe(true)
    expect(runtime.tabs.create).toHaveBeenCalledWith('https://www.douban.com/topic/create?subtype=note', false)
  })

  it('reuses a redirected Douban composer and does not keep opening tabs', async () => {
    const adapter = new DoubanAdapter()
    const runtime = zhihuRuntime(async (input: any, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/drafts') && init?.method === 'POST') {
        return new Response(JSON.stringify({ id: 'draft-123' }), { status: 200 })
      }
      if (url.includes('/draft-123?')) {
        return new Response(JSON.stringify({
          id: 'draft-123',
          draft_props: JSON.stringify({ title: '豆瓣测试', subtype: 'note', image_ids: [], content: {
            blocks: [{ key: '0', type: 'unstyled', text: '正文', depth: 0, inlineStyleRanges: [], entityRanges: [], data: {} }],
            entityMap: {},
          } }),
        }), { status: 200 })
      }
      return new Response('{}', { status: 404 })
    })
    runtime.fetch = vi.fn(runtime.fetch)
    runtime.getCookie = vi.fn(async () => 'cookie-ck')
    runtime.tabs = {
      query: vi.fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ id: 41, url: 'https://www.douban.com/', title: '发言' }]),
      create: vi.fn(), activate: vi.fn(), waitForLoad: vi.fn(),
      executeScript: vi.fn().mockResolvedValueOnce(doubanPage('')),
    }
    await adapter.init(runtime)

    const result = await adapter.saveDraft({ title: '豆瓣测试', html: '<p>正文</p>', markdown: '' }, {
      draftOnly: true, draftAuthorization: doubanDraftAuthorization,
    })

    expect(result.success).toBe(true)
    expect(result.postId).toBe('draft-123')
    expect(result.postUrl).toContain('/topic/create?draft_id=draft-123')
    expect(runtime.tabs.create).not.toHaveBeenCalled()
    expect(runtime.tabs.activate).not.toHaveBeenCalled()
    expect(runtime.fetch).toHaveBeenNthCalledWith(1, expect.stringMatching(/\/dwarf\/drafts$/), expect.objectContaining({
      method: 'POST',
      credentials: 'include',
      headers: expect.objectContaining({
        Accept: 'application/json',
        'Content-Type': 'application/json;charset=UTF-8',
        'X-CSRF-TOKEN': 'cookie-ck',
        'X-Requested-With': 'XMLHttpRequest',
      }),
    }))
  })

  it('uses the new dwarf draft API and never needs the removed note id', async () => {
    const adapter = new DoubanAdapter()
    const runtime = zhihuRuntime(async (input: any, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/drafts') && init?.method === 'POST') {
        return new Response(JSON.stringify({ id: 'draft-456' }), { status: 200 })
      }
      if (url.includes('/draft-456?')) {
        return new Response(JSON.stringify({
          id: 'draft-456', draft_props: {
            title: '豆瓣测试', subtype: 'note', image_ids: [],
            content: { blocks: [{ key: '0', type: 'unstyled', text: '正文', entityRanges: [] }], entityMap: {} },
          },
        }), { status: 200 })
      }
      return new Response('{}', { status: 404 })
    })
    runtime.fetch = vi.fn(runtime.fetch)
    runtime.getCookie = vi.fn(async () => 'cookie-ck')
    runtime.tabs = {
      query: vi.fn(async () => [{ id: 31, url: 'https://www.douban.com/note/create' }]),
      create: vi.fn(async () => ({ id: 32, url: 'https://www.douban.com/note/create' })),
      waitForLoad: vi.fn(),
      executeScript: vi.fn().mockResolvedValueOnce(doubanPage('')),
    }
    await adapter.init(runtime)

    const result = await adapter.saveDraft({ title: '豆瓣测试', html: '<p>正文</p>', markdown: '' }, {
      draftOnly: true, draftAuthorization: doubanDraftAuthorization,
    })

    expect(result.success).toBe(true)
    expect(result.postId).toBe('draft-456')
    expect(runtime.tabs.executeScript).toHaveBeenCalledTimes(1)
    expect(runtime.fetch).toHaveBeenCalledTimes(2)
    expect(runtime.fetch).toHaveBeenNthCalledWith(1, expect.stringMatching(/\/dwarf\/drafts$/), expect.objectContaining({
      method: 'POST',
      credentials: 'include',
      headers: expect.objectContaining({ 'Content-Type': 'application/json;charset=UTF-8' }),
    }))
  })

  it('keeps public publish disabled', async () => {
    const adapter = new DoubanAdapter()
    const result = await adapter.publish({ title: '不能发布', html: '<p>正文</p>', markdown: '' })
    expect(result.success).toBe(false)
    expect(result.error).toContain('公开发布永久禁用')
  })
})

describe('guarded Douyin draft adapter', () => {
  it('prefers SEO description for the 30-character Douyin summary and falls back to the first paragraph', () => {
    const canonical = parseCanonicalArticle('<h2>小标题</h2><p>正文首段用于摘要回退</p>', '测试')
    expect(buildDouyinSummary('SEO描述优先', canonical)).toBe('SEO描述优先')
    expect(buildDouyinSummary('', canonical)).toBe('正文首段用于摘要回退')
    expect(buildDouyinSummary('一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十一二三', canonical)).toBe('测试')
  })

  it('compresses a long SEO description into a complete Douyin summary instead of cutting a phrase', () => {
    const canonical = parseCanonicalArticle(
      '<p>正文第一段不应覆盖可压缩的 SEO 描述。</p>',
      '数据中心智能防雷系统选型与应用指南',
    )
    expect(buildDouyinSummary(
      '面向数据中心基础设施、机电与信息化负责人，说明数据中心智能防雷系统选型、配置与运维要点。',
      canonical,
    )).toBe('数据中心智能防雷系统选型、配置与运维要点。')
  })

  it('builds an official-import DOCX with ordered text, embedded images, and visible captions', async () => {
    const onePixelPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
    const canonical = parseCanonicalArticle(
      `<h2>第一节</h2><p><strong>加粗正文</strong></p><img src="${onePixelPng}" alt="现场图片说明"><p>结尾</p>`,
      '抖音导入测试',
    )

    const encoded = await buildDouyinImportDocx(canonical)
    const zip = await JSZip.loadAsync(encoded, { base64: true })
    const documentXml = await zip.file('word/document.xml')!.async('string')

    expect(zip.file('word/media/image1.png')).toBeTruthy()
    expect(documentXml).toContain('第一节')
    expect(documentXml).toContain('<w:b/>')
    expect(documentXml).toContain('descr="现场图片说明"')
    expect(documentXml.indexOf('加粗正文')).toBeLessThan(documentXml.indexOf('现场图片说明'))
    expect(documentXml).not.toContain('<w:t xml:space="preserve">现场图片说明</w:t>')
  })

  it('refuses a DOCX import when an image is not embedded in the authorized snapshot', async () => {
    const canonical = parseCanonicalArticle('<p>正文</p><img src="https://example.com/a.jpg" alt="外链图片">', '测试')
    await expect(buildDouyinImportDocx(canonical)).rejects.toThrow('不是可嵌入')
  })

  it('uses the current Chrome session cookie and waits for the creator SPA', async () => {
    const adapter = new DouyinAdapter()
    const runtime = zhihuRuntime(async () => new Response('{}', { status: 404 }))
    runtime.getCookie = vi.fn(async (_domain: string, name: string) => name === 'sessionid' ? 'session-cookie' : null)
    runtime.tabs = {
      query: vi.fn(async () => [{ id: 17, url: 'https://creator.douyin.com/creator-micro/content/upload?page=post_image' }]),
      create: vi.fn(), waitForLoad: vi.fn(),
      executeScript: vi.fn(async () => ({
        title: '抖音创作者中心',
        url: 'https://creator.douyin.com/creator-micro/content/upload?page=post_image',
        nickname: '抖音验收号', strongCreatorDom: true, hasLoginForm: false,
      })),
    }
    await adapter.init(runtime)

    const auth = await adapter.checkAuth()

    expect(auth).toMatchObject({ isAuthenticated: true, username: '抖音验收号' })
    expect(runtime.getCookie).toHaveBeenCalledWith('douyin.com', 'sessionid')
    expect(runtime.tabs.create).not.toHaveBeenCalled()
  })

  it('prefers the logged-in article editor over a stale Douyin login tab', async () => {
    const adapter = new DouyinAdapter()
    const runtime = zhihuRuntime(async () => new Response('{}', { status: 404 }))
    runtime.getCookie = vi.fn(async () => null)
    runtime.tabs = {
      query: vi.fn(async () => [
        { id: 17, url: 'https://creator.douyin.com/login' },
        { id: 18, url: 'https://creator.douyin.com/creator-micro/content/upload?page=article' },
      ]),
      create: vi.fn(), waitForLoad: vi.fn(),
      executeScript: vi.fn(async () => ({
        title: '发布文章',
        url: 'https://creator.douyin.com/creator-micro/content/upload?page=article',
        nickname: '', strongCreatorDom: true, hasLoginForm: false,
      })),
    }
    await adapter.init(runtime)

    const auth = await adapter.checkAuth()

    expect(auth.isAuthenticated).toBe(true)
    expect(runtime.tabs.executeScript).toHaveBeenCalledWith(18, expect.any(Function), [])
    expect(runtime.tabs.create).not.toHaveBeenCalled()
  })

  it('keeps publish disabled and requires a guarded task before probing the page', async () => {
    const adapter = new DouyinAdapter()
    const runtime = zhihuRuntime(async () => new Response('{}', { status: 404 }))
    runtime.tabs = { query: vi.fn(), create: vi.fn(), waitForLoad: vi.fn(), executeScript: vi.fn() }
    await adapter.init(runtime)

    await expect(adapter.publish({ title: '测试', html: '<p>正文</p>', markdown: '' })).rejects.toThrow('公开发布已禁用')
    const result = await adapter.saveDraft({ title: '测试', html: '<p>正文</p>', markdown: '' }, { draftOnly: true })

    expect(result.success).toBe(false)
    expect(result.error).toContain('任务/快照授权')
    expect(runtime.tabs.query).not.toHaveBeenCalled()
  })

  it('enters the article editor, waits for autosave, and returns a verified draft without publishing', async () => {
    const adapter = new DouyinAdapter()
    const runtime = zhihuRuntime(async () => new Response('{}', { status: 404 }))
    runtime.tabs = {
      query: vi.fn(async () => [{ id: 17, url: 'https://creator.douyin.com/creator-micro/content/upload?page=article' }]),
      create: vi.fn(), activate: vi.fn(), waitForLoad: vi.fn(),
      executeScript: vi.fn(async () => ({
        ok: true, draftId: '541636',
        url: 'https://creator.douyin.com/creator-micro/content/upload?page=article&draft_id=541636',
        title: '抖音测试文章',
        html: '<p><strong>正文</strong></p><figure><img src="a.jpg" alt="现场图"><figcaption>现场图</figcaption></figure>',
        bodyText: '正文', imageCount: 1, savedText: '已保存', summary: 'SEO摘要', captions: ['现场图'],
      })),
    }
    await adapter.init(runtime)

    const result = await adapter.saveDraft({
      title: '抖音测试文章',
      html: '<h1>抖音测试文章</h1><p><strong>正文</strong></p><hr><img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" alt="现场图">',
      markdown: '', summary: 'SEO摘要',
    }, {
      draftOnly: true, draftAuthorization: douyinDraftAuthorization,
    })

    expect(result.success).toBe(true)
    expect(result).toMatchObject({ postId: '541636', draftOnly: true, readBackVerified: true, fidelityVerified: true })
    expect(result.fidelityReport?.checks.find((check) => check.key === 'draft-only')?.status).toBe('PASS')
    expect(runtime.tabs.waitForLoad).not.toHaveBeenCalled()
    expect(runtime.tabs.create).not.toHaveBeenCalled()
  })
})

function xiaohongshuRuntime(pageResult: any) {
  const executeScript = vi.fn().mockResolvedValueOnce({ ok: true, authenticated: true }).mockResolvedValueOnce(pageResult)
  return {
    type: 'extension', fetch: vi.fn(),
    cookies: { get: vi.fn(), set: vi.fn(), remove: vi.fn() }, storage: { get: vi.fn(), set: vi.fn(), remove: vi.fn() }, session: { get: vi.fn(), set: vi.fn() },
    dom: { parseHTML: vi.fn(), querySelector: vi.fn(), querySelectorAll: vi.fn(), getTextContent: vi.fn(), getInnerHTML: vi.fn() },
    tabs: { query: vi.fn().mockResolvedValue([{ id: 7 }]), create: vi.fn(), activate: vi.fn(), waitForLoad: vi.fn(), executeScript },
  } as any
}

describe('guarded Xiaohongshu draft adapter', () => {
  it('removes duplicate title/dividers and recalculates long-article image anchors', () => {
    const source = parseCanonicalArticle(
      '<h1>小红书测试</h1><p>导语</p><hr><img src="a.jpg" alt="现场图"><p>结尾</p>',
      '小红书测试',
    )
    const normalized = normalizeXiaohongshuDraftArticle(source, '小红书测试')

    expect(normalized.blocks.map((block) => block.kind)).toEqual(['paragraph', 'image', 'paragraph'])
    expect(normalized.images[0].anchor).toBe(1)
  })

  it('ignores only platform-generated layout whitespace when comparing long-article text', () => {
    const source = '港区对象主要作用\n\n雷电预警提示雷暴临近信息'
    const readBack = '港区对象\t主要作用\n雷电预警\u200B提示雷暴临近信息'
    expect(normalizeXiaohongshuBodyForComparison(readBack)).toBe(normalizeXiaohongshuBodyForComparison(source))
    expect(normalizeXiaohongshuBodyForComparison(`${readBack}已修改`)).not.toBe(normalizeXiaohongshuBodyForComparison(source))
  })

  it('rejects public publish and taskless saveDraft', async () => {
    const adapter = new XiaohongshuAdapter()
    await adapter.init(xiaohongshuRuntime({ ok: false }))
    await expect(adapter.publish({ title: '测试', html: '<p>正文</p>', markdown: '' })).rejects.toThrow('公开发布已禁用')
    expect((await adapter.saveDraft({ title: '测试', html: '<p>正文</p>', markdown: '' }, { draftOnly: true })).success).toBe(false)
  })

  it('only succeeds after the creator draft database readback matches', async () => {
    const stages: string[] = []
    const adapter = new XiaohongshuAdapter()
    const runtime = xiaohongshuRuntime({ ok: true, draftId: 's:local-key', title: '测试', body: '正文\n\n现场图', imageCount: 1, imageCaptions: ['现场图'], imageAnchors: [1] })
    await adapter.init(runtime)
    expect((await adapter.checkAuth()).isAuthenticated).toBe(true)
    const result = await adapter.saveDraft({ title: '测试', html: '<p>正文</p><img src="data:image/png;base64,iVBORw0KGgo=" alt="现场图">', markdown: '' }, {
      draftOnly: true, draftAuthorization: xiaohongshuDraftAuthorization, onDraftStage: (stage) => stages.push(stage),
    })
    expect(result, result.error).toMatchObject({ success: true })
    expect(result.readBackVerified).toBe(true)
    expect(result.fidelityReport?.checks.find((item) => item.key === 'draft-only')?.status).toBe('PASS')
    expect(result.fidelityReport?.checks.find((item) => item.key === 'caption-equals-html-alt')?.status).toBe('PASS')
    const pageArticle = runtime.tabs.executeScript.mock.calls[1][2][0]
    expect(pageArticle.html).toContain('<p>__YIZAO_IMAGE_1__</p><p>现场图</p>')
    expect(pageArticle.html).not.toContain('__YIZAO_IMAGE_1__现场图')
    expect(stages).toEqual(['running', 'uploading', 'filling', 'saving_draft'])
  })

  it('uses the long-article path, accepts more than 1000 characters and never prefixes ALT captions', async () => {
    const longText = '长文内容'.repeat(300)
    const adapter = new XiaohongshuAdapter()
    const runtime = xiaohongshuRuntime({
      ok: true, draftId: 's:long-article', title: '长文测试', body: `${longText}\n\n现场图`,
      imageCount: 1, imageCaptions: ['现场图'], imageAnchors: [1],
    })
    await adapter.init(runtime)
    expect((await adapter.checkAuth()).isAuthenticated).toBe(true)
    const result = await adapter.saveDraft({
      title: '长文测试',
      html: `<p>${longText}</p><img src="data:image/png;base64,iVBORw0KGgo=" alt="现场图">`,
      markdown: '',
    }, { draftOnly: true, draftAuthorization: xiaohongshuDraftAuthorization })

    expect(result, result.error).toMatchObject({ success: true })
    expect(runtime.tabs.query).toHaveBeenCalledWith(expect.stringContaining('target=article'))
    expect(result.postUrl).toContain('target=article')
    expect(result.fidelityReport?.checks.find((item) => item.key === 'image-order')?.status).toBe('PASS')
  })

  it('prioritizes the exact new-creation action over the long-article navigation tab', async () => {
    const adapter = new XiaohongshuAdapter()
    const runtime = xiaohongshuRuntime({
      ok: true, draftId: 's:entry-priority', title: '入口测试', body: '正文\n\n现场图',
      imageCount: 1, imageCaptions: ['现场图'], imageAnchors: [1],
    })
    await adapter.init(runtime)
    await adapter.checkAuth()
    const result = await adapter.saveDraft({
      title: '入口测试', html: '<p>正文</p><img src="data:image/png;base64,iVBORw0KGgo=" alt="现场图">', markdown: '',
    }, { draftOnly: true, draftAuthorization: xiaohongshuDraftAuthorization })

    expect(result.success).toBe(true)
    const pageProcedure = String(runtime.tabs.executeScript.mock.calls[1][1])
    const createAction = pageProcedure.search(/actionByExactText\((['"])新的创作\1\)/)
    const navigationFallback = pageProcedure.search(/actionByExactText\((['"])写长文\1\)/)
    expect(createAction).toBeGreaterThan(-1)
    expect(navigationFallback).toBeGreaterThan(createAction)
    expect(pageProcedure).not.toMatch(/text\.includes\((['"])写长文\1\)/)
    expect(runtime.tabs.activate).toHaveBeenCalledWith(7)
    expect(pageProcedure).toContain('button, [role="button"], a, div, span')
    expect(pageProcedure).toContain('[contenteditable="true"].ProseMirror')
    expect(pageProcedure).toContain('__reactFiber$')
    expect(pageProcedure).toContain('memoizedProps?.editor')
    expect(pageProcedure).toContain('fresh || exact[0]')
    expect(pageProcedure).toContain('JSON.stringify(draft.imageCaptions) === JSON.stringify(expectedCaptions)')
    expect(pageProcedure).toContain('JSON.stringify(draft.imageAnchors) === JSON.stringify(expectedAnchors)')
    expect(pageProcedure).toContain('const caption = inlineCaption || followingCaption')
    expect(pageProcedure).toContain('if (!inlineCaption && followingCaption)')
  })

  it('accepts an unchanged reused draft key only after complete content readback matches', async () => {
    const adapter = new XiaohongshuAdapter()
    const runtime = xiaohongshuRuntime({
      ok: true, draftId: 's:reused-key', title: '重复暂存', body: '正文\n\n现场图',
      imageCount: 1, imageCaptions: ['现场图'], imageAnchors: [1], matchedExisting: true,
    })
    await adapter.init(runtime)
    await adapter.checkAuth()
    const result = await adapter.saveDraft({
      title: '重复暂存', html: '<p>正文</p><img src="data:image/png;base64,iVBORw0KGgo=" alt="现场图">', markdown: '',
    }, { draftOnly: true, draftAuthorization: xiaohongshuDraftAuthorization })
    expect(result.success).toBe(true)
    expect(result.fidelityReport?.checks.find((item) => item.key === 'draft-indexeddb')?.detail).toContain('复用了原草稿键')
  })
})

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
  it('maps duplicate titles, section headings and dividers to Sohu-stable layout', () => {
    const source = parseCanonicalArticle(
      '<h1>搜狐测试</h1><p>导语</p><hr><h2>一、标题</h2><table><tbody><tr><td>甲</td><td>乙</td></tr></tbody></table><img src="a.jpg" alt="图片说明">',
      '搜狐测试',
    )
    const normalized = normalizeSohuDraftArticle(source, '搜狐测试')
    const rendered = renderCanonicalArticle(normalized)

    expect(normalized.blocks.map((block) => block.kind)).toEqual(['paragraph', 'paragraph', 'table', 'image'])
    expect(rendered).not.toMatch(/<h[1-6]\b|<hr\b/i)
    expect(rendered).toContain('<p><strong>一、标题</strong></p>')
    expect(rendered).toContain('<table>')
    expect(normalized.images[0].anchor).toBe(3)
  })

  it('accepts Sohu paragraph merging, splitting and empty paragraphs without weakening text checks', () => {
    const source = parseCanonicalArticle(
      '<p>第一段文字</p><p>第二段文字</p><img src="a.jpg" alt="图片说明"><p>第三段文字</p>',
      '搜狐测试',
    )
    const equivalent = validateSohuFidelity(
      source,
      '<p>第一段文字<br>第二段文字</p><p><br></p><p><img src="https://img.mp.sohu.com/a.jpg" alt="图片说明" data-caption="图片说明"><span class="img-desc">图片说明</span></img></p><p>第三</p><p>段文字</p>',
      '搜狐测试',
    )
    const changed = validateSohuFidelity(
      source,
      '<p>第一段文字第二段文字有改动</p><p><img src="https://img.mp.sohu.com/a.jpg" alt="图片说明" data-caption="图片说明"><span class="img-desc">图片说明</span></img></p><p>第三段文字</p>',
      '搜狐测试',
    )

    expect(equivalent.checks.find((check) => check.key === 'main-block-order')?.status).toBe('PASS')
    expect(equivalent.checks.find((check) => check.key === 'image-anchor')?.status).toBe('PASS')
    expect(equivalent.checks.filter((check) => check.required && check.status !== 'PASS')).toEqual([])
    expect(changed.checks.find((check) => check.key === 'main-block-order')?.status).toBe('FAIL')
    expect(changed.fidelityVerified).toBe(false)
  })

  it('recognizes the current v4 account list response', async () => {
    const adapter = new SohuAdapter()
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      code: 2000000,
      data: { data: [{ accountInfos: [{ id: '88', nickName: '搜狐验收号', avatar: '' }] }], total: 1 },
    }), { status: 200 }))
    await adapter.init(zhihuRuntime(fetchMock))

    const auth = await adapter.checkAuth()

    expect(auth.isAuthenticated).toBe(true)
    expect(auth.userId).toBe('88')
    expect(fetchMock.mock.calls[0][0]).toContain('/account/listV2')
  })

  it('uses the currently selected Sohu sub-account and preserves a long account id as text', async () => {
    const firstId = '91000000000000000001'
    const selectedId = '91000000000000000009'
    let savedBody: any = null
    let savedUrl = ''
    const runtime = zhihuRuntime(async (url, options) => {
      if (url.includes('/mpbp/bp/account/listV2')) return new Response(JSON.stringify({
        code: 2000000,
        data: { data: [{ accountInfos: [
          { id: firstId, nickName: '列表首号', avatar: '' },
          { id: selectedId, nickName: '当前选中号', avatar: '' },
        ] }] },
      }), { status: 200 })
      if (url.includes('/news/v4/news/draft/v2') && options?.method === 'POST') {
        savedUrl = url
        savedBody = JSON.parse(String(options.body))
        return new Response(JSON.stringify({ code: 2000, data: { id: 35791 } }), { status: 200 })
      }
      if (url.includes('/news/v4/article?newsId=35791')) return new Response(JSON.stringify({
        code: 2000, data: { news: { id: 35791, title: '多账号测试', content: savedBody.content } },
      }), { status: 200 })
      return new Response('{}', { status: 404 })
    })
    runtime.tabs = {
      query: vi.fn().mockResolvedValue([{ id: 7, url: 'https://mp.sohu.com/mpfe/v4/' }]),
      create: vi.fn(), waitForLoad: vi.fn(),
      executeScript: vi.fn().mockResolvedValue({ id: selectedId, nickName: '当前选中号', avatar: '' }),
    }
    const adapter = new SohuAdapter()
    await adapter.init(runtime)
    const result = await adapter.saveDraft({ title: '多账号测试', html: '<p>正文</p>', markdown: '' }, { draftOnly: true, draftAuthorization: sohuDraftAuthorization })
    expect(result.success).toBe(true)
    expect(savedBody.accountId).toBe(selectedId)
    expect(typeof savedBody.accountId).toBe('string')
    expect(savedUrl).toContain(`accountId=${selectedId}`)
  })

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
      if (url.includes('/mpbp/bp/account/listV2')) return new Response(JSON.stringify({ code: 2000000, data: { data: [{ accountInfos: [{ id: '88', nickName: '验收号', avatar: '' }] }] } }), { status: 200 })
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
    expect(savedContent).toContain('<p style="text-align:center;"><img src="https://img.mp.sohu.com/test.png" alt="搜狐图片注释"><span class="img-desc" style="font-size: 16px;">搜狐图片注释</span></img></p>')
    expect(savedContent).toContain('</p><p><strong>后文</strong></p>')
    expect(stages).toEqual(['running', 'uploading', 'filling', 'saving_draft'])
  })

  it('accepts the current Sohu readback business code when exact draft id and content match', async () => {
    let savedContent = ''
    const adapter = new SohuAdapter()
    await adapter.init(zhihuRuntime(async (url, options) => {
      if (url.includes('/mpbp/bp/account/listV2')) return new Response(JSON.stringify({ code: 2000000, data: { data: [{ accountInfos: [{ id: '88', nickName: '验收号', avatar: '' }] }] } }), { status: 200 })
      if (url.includes('/news/v4/news/draft/v2') && options?.method === 'POST') {
        savedContent = JSON.parse(String(options.body)).content
        return new Response(JSON.stringify({ success: true, data: 97531 }), { status: 200 })
      }
      if (url.includes('/news/v4/article?newsId=97531')) return new Response(JSON.stringify({ code: 2000, success: true, data: { news: { id: 97531, title: '搜狐新码测试', content: savedContent } } }), { status: 200 })
      return new Response('{}', { status: 404 })
    }))
    const result = await adapter.saveDraft({
      title: '搜狐新码测试', html: '<p>正文保持一致</p>', markdown: '',
    }, { draftOnly: true, draftAuthorization: sohuDraftAuthorization })
    expect(result.success).toBe(true)
    expect(result.readBackVerified).toBe(true)
  })

  it('still rejects a Sohu failure code when returned data cannot verify this draft', async () => {
    const adapter = new SohuAdapter()
    await adapter.init(zhihuRuntime(async (url, options) => {
      if (url.includes('/mpbp/bp/account/listV2')) return new Response(JSON.stringify({ code: 2000000, data: { data: [{ accountInfos: [{ id: '88', nickName: '验收号', avatar: '' }] }] } }), { status: 200 })
      if (url.includes('/news/v4/news/draft/v2') && options?.method === 'POST') return new Response(JSON.stringify({ success: true, data: 86420 }), { status: 200 })
      if (url.includes('/news/v4/article?newsId=86420')) return new Response(JSON.stringify({ code: 5001, success: false, msg: '读取失败', data: null }), { status: 200 })
      return new Response('{}', { status: 404 })
    }))
    const result = await adapter.saveDraft({ title: '搜狐失败码测试', html: '<p>正文</p>', markdown: '' }, { draftOnly: true, draftAuthorization: sohuDraftAuthorization })
    expect(result.success).toBe(false)
    expect(result.error).toContain('读取失败')
    expect(result.readBackVerified).not.toBe(true)
  })

  it('does not report success when the saved content cannot be read back', async () => {
    const adapter = new SohuAdapter()
    await adapter.init(zhihuRuntime(async (url) => {
      if (url.includes('/mpbp/bp/account/listV2')) return new Response(JSON.stringify({ code: 2000000, data: { data: [{ accountInfos: [{ id: '88', nickName: '验收号', avatar: '' }] }] } }), { status: 200 })
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
        if (request.kind === 'fill-editor') return { titleFilled: true, bodyFilled: true, titleKind: 'textarea', bodyKind: 'div[contenteditable]' }
        if (request.method === 'HEAD') return { ok: true, status: 200, text: '', securityToken: '0,csrf-test-token,86370000,success,session' }
        if (request.imageSource) return { ok: true, status: 200, text: JSON.stringify({ code: 0, data: { url: '//p1.toutiaoimg.com/origin/test', web_uri: 'pgc-image/test', width: 600, height: 400, mime_type: 'image/jpeg' } }) }
        if (request.url.startsWith('/mp/agw/article/new')) {
          return { ok: true, status: 200, text: JSON.stringify({ code: 0, data: { media_id: 'media-9988', article_ad_type: 3, mp_publish_ab_val: 'current-ab' } }) }
        }
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
    expect(savedForm.article_ad_type).toBe('3')
    expect(savedForm.title_id).toMatch(/^[0-9]+_media-9988$/)
    expect(savedForm.draft_form_data).toBe('{"coverType":2}')
    expect(JSON.parse(savedForm.extra)).toMatchObject({ content_source: 100000000402, tuwen_wtt_transfer_switch: '1' })
    expect(savedContent).toContain('class="pgc-img-caption">头条图片描述</p>')
    expect(savedContent).toContain('web_uri="pgc-image/test"')
    expect(savedContent).toContain('data-track="1"')
    expect(stages).toEqual(['running', 'uploading', 'filling', 'saving_draft'])
    const fillRequest = (runtime.tabs.executeScript as any).mock.calls.map((call: any[]) => call[2][0]).find((request: any) => request.kind === 'fill-editor')
    expect(fillRequest.title).toBe('头条测试')
    expect(fillRequest.html).toContain('class="pgc-img-caption">头条图片描述</p>')
    const fillProcedure = String((runtime.tabs.executeScript as any).mock.calls.find((call: any[]) => call[2][0]?.kind === 'fill-editor')?.[1])
    expect(fillProcedure).toContain('stripLeadingEditorPlaceholders')
    expect(fillProcedure).toMatch(/tag === ["']p["'] \|\| tag === ["']div["'] \|\| tag === ["']br["']/)
    const publishRequest = (runtime.tabs.executeScript as any).mock.calls.map((call: any[]) => call[2][0]).find((request: any) => String(request.url || '').startsWith('/mp/agw/article/publish'))
    expect(publishRequest.headers['x-secsdk-csrf-token']).toBe('csrf-test-token')
    expect(publishRequest.url).toContain('mp_publish_ab_val=current-ab')
  })

  it('keeps Toutiao business diagnostics when the draft API returns a generic failure', async () => {
    const adapter = new ToutiaoAdapter()
    const runtime = zhihuRuntime(async () => new Response(JSON.stringify({ data: { user: { id: '88' } } }), { status: 200 }))
    runtime.tabs = {
      query: vi.fn(async () => [{ id: 7 }]), create: vi.fn(), waitForLoad: vi.fn(),
      executeScript: vi.fn(async (_tabId: number, _func: unknown, args: any[]) => {
        const request = args[0]
        if (request.kind === 'fill-editor') return { titleFilled: true, bodyFilled: true, titleKind: 'textarea', bodyKind: 'div[contenteditable]' }
        if (request.url.startsWith('/mp/agw/article/new')) return { ok: true, status: 200, text: JSON.stringify({ code: 0, data: { media_id: '88', article_ad_type: 3 } }) }
        if (request.method === 'HEAD') return { ok: true, status: 200, text: '', securityToken: '0,csrf-diagnostic-token,86370000,success,session' }
        return { ok: true, status: 200, text: JSON.stringify({ code: 7050, message: '保存失败', data: { prompt: '请刷新编辑页后重试' }, traceId: 'trace-safe-123' }) }
      }),
    }
    await adapter.init(runtime)

    const result = await adapter.saveDraft({ title: '头条诊断', html: '<p>正文</p>', markdown: '' }, { draftOnly: true, draftAuthorization: toutiaoDraftAuthorization })

    expect(result.success).toBe(false)
    expect(result.error).toContain('保存失败')
    expect(result.error).toContain('请刷新编辑页后重试')
    expect(result.error).toContain('code=7050')
    expect(result.error).toContain('页面安全令牌=已附加')
    expect(result.error).toContain('traceId=trace-safe-123')
    expect(result.error).not.toContain('csrf-diagnostic-token')
  })

  it('stops before protocol save when the current Toutiao editor cannot accept the article', async () => {
    const adapter = new ToutiaoAdapter()
    const runtime = zhihuRuntime(async () => new Response(JSON.stringify({ data: { user: { id: '88' } } }), { status: 200 }))
    const executeScript = vi.fn(async (_tabId: number, _func: unknown, args: any[]) => {
      const request = args[0]
      if (request.kind === 'fill-editor') return { titleFilled: true, bodyFilled: false, titleKind: 'textarea', bodyKind: '' }
      return { ok: true, status: 200, text: JSON.stringify({ code: 0, data: {} }) }
    })
    runtime.tabs = { query: vi.fn(async () => [{ id: 7 }]), create: vi.fn(), waitForLoad: vi.fn(), executeScript }
    await adapter.init(runtime)

    const result = await adapter.saveDraft({ title: '页面导入检查', html: '<p>正文</p>', markdown: '' }, { draftOnly: true, draftAuthorization: toutiaoDraftAuthorization })

    expect(result.success).toBe(false)
    expect(result.error).toContain('页面导入失败')
    expect(executeScript.mock.calls.some((call: any[]) => String(call[2][0]?.url || '').includes('/article/publish'))).toBe(false)
  })

  it('retries once when Chrome temporarily locks the Toutiao editor tab', async () => {
    const adapter = new ToutiaoAdapter()
    const runtime = zhihuRuntime(async () => new Response(JSON.stringify({ data: { user: { id: '88' } } }), { status: 200 }))
    let savedContent = ''
    const executeScript = vi.fn()
      .mockRejectedValueOnce(new Error('Tabs cannot be edited right now (user may be dragging a tab).'))
      .mockImplementation(async (_tabId: number, _func: unknown, args: any[]) => {
        const request = args[0]
        if (request.kind === 'fill-editor') return { titleFilled: true, bodyFilled: true, titleKind: 'textarea', bodyKind: 'div[contenteditable]' }
        if (request.method === 'HEAD') return { ok: true, status: 200, text: '' }
        if (request.url.startsWith('/mp/agw/article/publish')) {
          savedContent = request.form.content
          return { ok: true, status: 200, text: JSON.stringify({ code: 0, data: { pgc_id: '97531' } }) }
        }
        return { ok: true, status: 200, text: JSON.stringify({ code: 0, data: { pgc_id: '97531', title: '头条重试', content: savedContent } }) }
      })
    runtime.tabs = { query: vi.fn(async () => [{ id: 7 }]), create: vi.fn(), waitForLoad: vi.fn(), executeScript }
    await adapter.init(runtime)

    const result = await adapter.saveDraft({ title: '头条重试', html: '<p>正文</p>', markdown: '' }, { draftOnly: true, draftAuthorization: toutiaoDraftAuthorization })

    expect(result.success).toBe(true)
    expect(result.postId).toBe('97531')
    expect(executeScript).toHaveBeenCalledTimes(6)
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

  it('accepts the nested image response variants returned by the current Toutiao editor', async () => {
    let savedContent = ''
    const adapter = new ToutiaoAdapter()
    const runtime = zhihuRuntime(async () => new Response(JSON.stringify({ data: { user: { id_str: '88' } } }), { status: 200 }))
    runtime.tabs = {
      query: vi.fn(async () => [{ id: 7 }]), create: vi.fn(), waitForLoad: vi.fn(),
      executeScript: vi.fn(async (_tabId: number, _func: unknown, args: any[]) => {
        const request = args[0]
        if (request.kind === 'fill-editor') return { titleFilled: true, bodyFilled: true, titleKind: 'textarea', bodyKind: 'div[contenteditable]' }
        if (request.imageSource) {
          return { ok: true, status: 200, text: JSON.stringify({ code: 0, data: { image_list: [{ image_url: '//p3.toutiaoimg.com/origin/nested-test', origin_web_uri: 'pgc-image/nested-test', img_width: 600, img_height: 400 }] } }) }
        }
        if (request.url.startsWith('/mp/agw/article/publish')) {
          savedContent = request.form.content
          return { ok: true, status: 200, text: JSON.stringify({ code: 0, data: { pgc_id: '24680' } }) }
        }
        return { ok: true, status: 200, text: JSON.stringify({ code: 0, data: { pgc_id: '24680', title: '头条嵌套响应', content: savedContent } }) }
      }),
    }
    await adapter.init(runtime)
    const result = await adapter.saveDraft({
      title: '头条嵌套响应',
      html: '<p>正文</p><img src="data:image/png;base64,iVBORw==" alt="图片说明">',
      markdown: '',
    }, { draftOnly: true, draftAuthorization: toutiaoDraftAuthorization })

    expect(result.success).toBe(true)
    expect(savedContent).toContain('src="https://p3.toutiaoimg.com/origin/nested-test"')
    expect(savedContent).toContain('web_uri="pgc-image/nested-test"')
    expect(savedContent).toContain('img_width="600"')
  })

  it('accepts current Toutiao origin_image URL and URI fields without losing image metadata', async () => {
    let savedContent = ''
    const adapter = new ToutiaoAdapter()
    const runtime = zhihuRuntime(async () => new Response(JSON.stringify({ data: { user: { id_str: '88' } } }), { status: 200 }))
    runtime.tabs = {
      query: vi.fn(async () => [{ id: 7 }]), create: vi.fn(), waitForLoad: vi.fn(),
      executeScript: vi.fn(async (_tabId: number, _func: unknown, args: any[]) => {
        const request = args[0]
        if (request.kind === 'fill-editor') return { titleFilled: true, bodyFilled: true, titleKind: 'textarea', bodyKind: 'div[contenteditable]' }
        if (request.imageSource) {
          return {
            ok: true,
            status: 200,
            text: JSON.stringify({
              code: 0,
              data: {
                image_uri: 'tos-cn-i-test/enhanced',
                image_url: 'tos-cn-i-test/enhanced~tplv-test.image',
                origin_image_uri: 'tos-cn-i-test/original',
                origin_image_url: 'https://p3-sign.toutiaoimg.com/tos-cn-i-test/original~tplv-test.image',
                image_width: 600,
                image_height: 400,
                image_format: 'jpeg',
                image_mime_type: 'image/jpeg',
              },
            }),
          }
        }
        if (request.url.startsWith('/mp/agw/article/publish')) {
          savedContent = request.form.content
          return { ok: true, status: 200, text: JSON.stringify({ code: 0, data: { pgc_id: '24682' } }) }
        }
        return { ok: true, status: 200, text: JSON.stringify({ code: 0, data: { pgc_id: '24682', title: '头条当前响应', content: savedContent } }) }
      }),
    }
    await adapter.init(runtime)
    const result = await adapter.saveDraft({
      title: '头条当前响应', html: '<img src="data:image/png;base64,iVBORw==" alt="当前图片说明">', markdown: '',
    }, { draftOnly: true, draftAuthorization: toutiaoDraftAuthorization })

    expect(result.success).toBe(true)
    expect(savedContent).toContain('src="https://p3-sign.toutiaoimg.com/tos-cn-i-test/original~tplv-test.image"')
    expect(savedContent).toContain('web_uri="tos-cn-i-test/original"')
    expect(savedContent).toContain('img_width="600"')
    expect(savedContent).toContain('img_height="400"')
    expect(savedContent).toContain('class="pgc-img-caption">当前图片说明</p>')
  })

  it('builds a trusted CDN URL when current Toutiao returns only a resource URI', async () => {
    let savedContent = ''
    const adapter = new ToutiaoAdapter()
    const runtime = zhihuRuntime(async () => new Response(JSON.stringify({ data: { user: { id_str: '88' } } }), { status: 200 }))
    runtime.tabs = {
      query: vi.fn(async () => [{ id: 7 }]), create: vi.fn(), waitForLoad: vi.fn(),
      executeScript: vi.fn(async (_tabId: number, _func: unknown, args: any[]) => {
        const request = args[0]
        if (request.kind === 'fill-editor') return { titleFilled: true, bodyFilled: true, titleKind: 'textarea', bodyKind: 'div[contenteditable]' }
        if (request.imageSource) return { ok: true, status: 200, text: JSON.stringify({ code: 0, data: { image_uri: 'tos-cn-i-test/generated' } }) }
        if (request.url.startsWith('/mp/agw/article/publish')) {
          savedContent = request.form.content
          return { ok: true, status: 200, text: JSON.stringify({ code: 0, data: { pgc_id: '24683' } }) }
        }
        return { ok: true, status: 200, text: JSON.stringify({ code: 0, data: { pgc_id: '24683', title: '头条资源标识', content: savedContent } }) }
      }),
    }
    await adapter.init(runtime)
    const result = await adapter.saveDraft({
      title: '头条资源标识', html: '<img src="data:image/png;base64,iVBORw==" alt="图片说明">', markdown: '',
    }, { draftOnly: true, draftAuthorization: toutiaoDraftAuthorization })

    expect(result.success).toBe(true)
    expect(savedContent).toContain('src="https://p1.toutiaoimg.com/origin/tos-cn-i-test/generated"')
    expect(savedContent).toContain('web_uri="tos-cn-i-test/generated"')
  })

  it('rejects untrusted image URLs and invalid resource URIs before saving a draft', async () => {
    const adapter = new ToutiaoAdapter()
    const runtime = zhihuRuntime(async () => new Response(JSON.stringify({ data: { user: { id_str: '88' } } }), { status: 200 }))
    const executeScript = vi.fn(async (_tabId: number, _func: unknown, args: any[]) => {
      const request = args[0]
      if (request.kind === 'fill-editor') return { titleFilled: true, bodyFilled: true, titleKind: 'textarea', bodyKind: 'div[contenteditable]' }
      if (request.imageSource) {
        return { ok: true, status: 200, text: JSON.stringify({ code: 0, data: { origin_image_url: 'https://evil.example/image.jpg', image_uri: 'https://evil.example/image.jpg' } }) }
      }
      return { ok: true, status: 200, text: JSON.stringify({ code: 0, data: { pgc_id: '99999' } }) }
    })
    runtime.tabs = {
      query: vi.fn(async () => [{ id: 7 }]), create: vi.fn(), waitForLoad: vi.fn(), executeScript,
    }
    await adapter.init(runtime)
    const result = await adapter.saveDraft({
      title: '头条不可信图片', html: '<img src="data:image/png;base64,iVBORw==" alt="图片说明">', markdown: '',
    }, { draftOnly: true, draftAuthorization: toutiaoDraftAuthorization })

    expect(result.success).toBe(false)
    expect(result.error).toContain('缺少 URL 或 web_uri')
    expect(executeScript).toHaveBeenCalledTimes(1)
  })

  it('derives web_uri only from a trusted Toutiao CDN image URL', async () => {
    let savedContent = ''
    const adapter = new ToutiaoAdapter()
    const runtime = zhihuRuntime(async () => new Response(JSON.stringify({ data: { user: { id_str: '88' } } }), { status: 200 }))
    runtime.tabs = {
      query: vi.fn(async () => [{ id: 7 }]), create: vi.fn(), waitForLoad: vi.fn(),
      executeScript: vi.fn(async (_tabId: number, _func: unknown, args: any[]) => {
        const request = args[0]
        if (request.kind === 'fill-editor') return { titleFilled: true, bodyFilled: true, titleKind: 'textarea', bodyKind: 'div[contenteditable]' }
        if (request.imageSource) return { ok: true, status: 200, text: JSON.stringify({ code: 0, data: { image: { url: 'https://p3-sign.toutiaoimg.com/tos-cn-i-test/image~tplv-test.image' } } }) }
        if (request.url.startsWith('/mp/agw/article/publish')) {
          savedContent = request.form.content
          return { ok: true, status: 200, text: JSON.stringify({ code: 0, data: { pgc_id: '24681' } }) }
        }
        return { ok: true, status: 200, text: JSON.stringify({ code: 0, data: { pgc_id: '24681', title: '头条 URI 推导', content: savedContent } }) }
      }),
    }
    await adapter.init(runtime)
    const result = await adapter.saveDraft({
      title: '头条 URI 推导', html: '<img src="data:image/png;base64,iVBORw==" alt="图片说明">', markdown: '',
    }, { draftOnly: true, draftAuthorization: toutiaoDraftAuthorization })

    expect(result.success).toBe(true)
    expect(savedContent).toContain('web_uri="tos-cn-i-test/image"')
  })
})

describe('guarded NetEase draft adapter', () => {
  it('maps unsupported headings, tables and dividers to stable readable paragraphs', () => {
    const source = parseCanonicalArticle(
      '<h1>网易测试</h1><p>导语</p><hr><h2>一、标题</h2><table><tbody><tr><th>项目</th><th>说明</th></tr><tr><td>甲</td><td>乙</td></tr></tbody></table><img src="a.jpg" alt="图注"><p>结尾</p>',
      '网易测试',
    )
    const normalized = normalizeNeteaseDraftArticle(source, '网易测试')
    const rendered = renderCanonicalArticle(normalized)

    expect(normalized.blocks.map((block) => block.kind)).toEqual(['paragraph', 'paragraph', 'paragraph', 'paragraph', 'image', 'paragraph'])
    expect(rendered).not.toMatch(/<h[1-6]\b|<table\b|<hr\b/i)
    expect(rendered).toContain('<p><strong>一、标题</strong></p>')
    expect(rendered).toContain('<p>项目　说明</p><p>甲　乙</p>')
    expect(normalized.images[0].anchor).toBe(4)
  })

  it('accepts NetEase paragraph splitting while keeping exact text and image character offsets', () => {
    const source = parseCanonicalArticle('<h2>小节</h2><p>第一段</p><img src="a.jpg" alt="图注"><p>第二段</p>', '网易测试')
    const readBack = '<p>小节<br>第一段</p><p><img src="https://cms-bucket.ws.126.net/a.jpg" alt="图注"><br>图注</p><p>第二段</p>'
    const report = validateNeteaseFidelity(source, readBack, '网易测试')
    expect(report.fidelityVerified).toBe(true)
    expect(report.checks.find((item) => item.key === 'main-block-order')?.status).toBe('PASS')
    expect(report.checks.find((item) => item.key === 'image-anchor')?.status).toBe('PASS')
  })

  it('still rejects a NetEase draft when an image moves across actual正文 text', () => {
    const source = parseCanonicalArticle('<p>第一段</p><img src="a.jpg" alt="图注"><p>第二段</p>', '网易测试')
    const moved = '<p>第一段第二段</p><p><img src="https://cms-bucket.ws.126.net/a.jpg" alt="图注"><br>图注</p>'
    const report = validateNeteaseFidelity(source, moved, '网易测试')
    expect(report.fidelityVerified).toBe(false)
    expect(report.checks.find((item) => item.key === 'image-anchor')?.status).toBe('FAIL')
  })
  it('does not auto-check platforms whose login probe opens an editor tab', () => {
    expect(shouldAutoCheckPlatformAuth(new NeteaseAdapter().meta)).toBe(false)
    expect(shouldAutoCheckPlatformAuth(new XiaohongshuAdapter().meta)).toBe(false)
    expect(shouldAutoCheckPlatformAuth(new DoubanAdapter().meta)).toBe(false)
    expect(shouldAutoCheckPlatformAuth(new DouyinAdapter().meta)).toBe(false)
    expect(shouldAutoCheckPlatformAuth(new ZhihuAdapter().meta)).toBe(true)
  })

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
        if (request.url === '/wemedia/navinfo.do') return { ok: true, status: 200, text: JSON.stringify({ code: 100021, data: { userInfo: { wemediaId: 'media88', mediaName: '网易验收号' } } }) }
        if (request.imageSource) return { ok: true, status: 200, text: JSON.stringify({ code: 1, data: { url: '//dingyue.ws.126.net/test.jpg' } }) }
        if (request.url === '/wemedia/article/status/api/publishV2.do') {
          savedForm = request.form
          savedContent = request.form.content
          return { ok: true, status: 200, text: JSON.stringify({ code: 1, data: 'docId=doc_13579&pkId=9' }) }
        }
        if (request.url.startsWith('/wemedia/article/editpage.do')) return {
          ok: true, status: 200,
          text: JSON.stringify({ code: 1, data: { post: { docid: 'doc_13579', title: '网易测试', body: savedContent } } }),
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
    expect(savedContent).not.toMatch(/<h[1-6]\b|<table\b|<hr\b/i)
    expect(stages).toEqual(['running', 'uploading', 'filling', 'saving_draft'])
  })

  it('retries only NetEase draft readback when newly saved content is not ready yet', async () => {
    const adapter = new NeteaseAdapter()
    const runtime = zhihuRuntime(async () => new Response('{}', { status: 404 }))
    let saveAttempts = 0
    let readAttempts = 0
    let savedContent = ''
    runtime.tabs = {
      query: vi.fn(async () => [{ id: 17 }]), create: vi.fn(), waitForLoad: vi.fn(),
      executeScript: vi.fn(async (_tabId: number, _func: unknown, args: any[]) => {
        const request = args[0]
        if (request.guardian) return { ok: true, status: 200, text: JSON.stringify({ code: 200, token: 'official-guardian-token' }) }
        if (request.url === '/wemedia/navinfo.do') return { ok: true, status: 200, text: JSON.stringify({ code: 1, data: { wemediaId: 'media88' } }) }
        if (request.url === '/wemedia/article/status/api/publishV2.do') {
          saveAttempts += 1
          savedContent = request.form.content
          return { ok: true, status: 200, text: JSON.stringify({ code: 1, data: 'docId=doc_delayed' }) }
        }
        if (request.url.startsWith('/wemedia/article/editpage.do')) {
          readAttempts += 1
          return readAttempts < 3
            ? { ok: true, status: 200, text: JSON.stringify({ code: 1, data: { post: { docid: 'doc_delayed', title: '延迟回读', body: '' } } }) }
            : { ok: true, status: 200, text: JSON.stringify({ code: 1, data: { post: { docid: 'doc_delayed', title: '延迟回读', body: savedContent } } }) }
        }
        return { ok: false, status: 404, text: '{}' }
      }),
    }
    await adapter.init(runtime)
    vi.spyOn(adapter as any, 'delay').mockResolvedValue(undefined)

    const result = await adapter.saveDraft({
      title: '延迟回读', html: '<p>正文</p>', markdown: '',
    }, { draftOnly: true, draftAuthorization: neteaseDraftAuthorization })

    expect(result.success).toBe(true)
    expect(result.readBackVerified).toBe(true)
    expect(saveAttempts).toBe(1)
    expect(readAttempts).toBe(3)
  })

  it('fails closed with a useful message when the page script returns no result', async () => {
    const adapter = new NeteaseAdapter()
    const runtime = zhihuRuntime(async () => new Response('{}', { status: 404 }))
    runtime.tabs = {
      query: vi.fn(async () => [{ id: 17 }]), create: vi.fn(), waitForLoad: vi.fn(),
      executeScript: vi.fn(async () => null),
    }
    await adapter.init(runtime)

    const auth = await adapter.checkAuth()

    expect(auth.isAuthenticated).toBe(false)
    expect(auth.error).toContain('网易号页面未返回登录检查结果')
  })

  it('retries transient HTTP 0 image upload interruptions before failing the draft', async () => {
    const adapter = new NeteaseAdapter()
    const runtime = zhihuRuntime(async () => new Response('{}', { status: 404 }))
    let attempts = 0
    runtime.tabs = {
      query: vi.fn(async () => [{ id: 17 }]), create: vi.fn(), waitForLoad: vi.fn(),
      executeScript: vi.fn(async (_tabId: number, _func: unknown, args: any[]) => {
        if (!args[0].imageSource) throw new Error('only image upload is expected')
        attempts += 1
        if (attempts < 3) return { ok: false, status: 0, text: JSON.stringify({ error: 'network-error' }) }
        return { ok: true, status: 200, text: JSON.stringify({ code: 1, data: { url: '//dingyue.ws.126.net/retried.jpg' } }) }
      }),
    }
    await adapter.init(runtime)

    const result = await (adapter as any).uploadImageByUrl('data:image/png;base64,iVBORw==')

    expect(result.url).toBe('https://dingyue.ws.126.net/retried.jpg')
    expect(attempts).toBe(3)
    expect(runtime.tabs.waitForLoad).toHaveBeenCalledTimes(2)
  })

  it('normalizes current NetEase upload response variants to trusted HTTPS CDN URLs', async () => {
    const variants = [
      { code: 200, data: 'http://dingyue.ws.126.net/string-result.jpg' },
      { code: 1, data: { imageUrl: 'http://cms-bucket.ws.126.net/image-url.jpg' } },
      { data: { result: { src: '//dingyue.ws.126.net/nested-src.jpg' } } },
      { url: 'https://dingyue.ws.126.net/root-url.jpg' },
    ]
    const expected = [
      'https://dingyue.ws.126.net/string-result.jpg',
      'https://cms-bucket.ws.126.net/image-url.jpg',
      'https://dingyue.ws.126.net/nested-src.jpg',
      'https://dingyue.ws.126.net/root-url.jpg',
    ]
    for (let index = 0; index < variants.length; index += 1) {
      const adapter = new NeteaseAdapter()
      const runtime = zhihuRuntime(async () => new Response('{}', { status: 404 }))
      runtime.tabs = {
        query: vi.fn(async () => [{ id: 17 }]), create: vi.fn(), waitForLoad: vi.fn(),
        executeScript: vi.fn(async () => ({ ok: true, status: 200, text: JSON.stringify(variants[index]) })),
      }
      await adapter.init(runtime)
      await expect((adapter as any).uploadImageByUrl('data:image/png;base64,iVBORw==')).resolves.toEqual({ url: expected[index] })
    }
  })

  it('still rejects non-NetEase upload URLs even when nested in a successful response', async () => {
    const adapter = new NeteaseAdapter()
    const runtime = zhihuRuntime(async () => new Response('{}', { status: 404 }))
    runtime.tabs = {
      query: vi.fn(async () => [{ id: 17 }]), create: vi.fn(), waitForLoad: vi.fn(),
      executeScript: vi.fn(async () => ({ ok: true, status: 200, text: JSON.stringify({ code: 1, data: { result: { url: 'https://evil.example/image.jpg' } } }) })),
    }
    await adapter.init(runtime)
    await expect((adapter as any).uploadImageByUrl('data:image/png;base64,iVBORw==')).rejects.toThrow('缺少受信任的 HTTPS 图片 URL')
  })

  it('stops before saving when the official guardian token is unavailable', async () => {
    const adapter = new NeteaseAdapter()
    const runtime = zhihuRuntime(async () => new Response('{}', { status: 404 }))
    runtime.tabs = {
      query: vi.fn(async () => [{ id: 17 }]), create: vi.fn(), waitForLoad: vi.fn(),
      executeScript: vi.fn(async (_tabId: number, _func: unknown, args: any[]) => {
        const request = args[0]
        if (request.url === '/wemedia/navinfo.do') return { ok: true, status: 200, text: JSON.stringify({ code: 1, data: { wemediaId: 'media88' } }) }
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
    version: '0.6.2-stage7-caption-cleanup',
    protocol: { name: 'yizao-local-service', version: 2 },
    build: { packageVersion: 42, id: EXTENSION_BUILD_ID, extensionBuildId: EXTENSION_BUILD_ID },
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
      extensionVersion: '2.0.9.9', articleId: 'pkg-safe', packageId: 'pkg-safe',
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

  it('removes packaging image ordinals from every visible ALT caption', () => {
    const article = parseCanonicalArticle(
      '<img src="a" alt="图片1：易造智能雷暴仪用于无人机作业雷暴监测"><img src="b" alt="图 2: 双探头结构示意">',
      '测试标题',
    )
    expect(article.images.map((image) => image.alt)).toEqual([
      '易造智能雷暴仪用于无人机作业雷暴监测',
      '双探头结构示意',
    ])
    const rendered = renderCanonicalArticle(article)
    expect(rendered).toContain('<figcaption>易造智能雷暴仪用于无人机作业雷暴监测</figcaption>')
    expect(rendered).toContain('<figcaption>双探头结构示意</figcaption>')
    expect(rendered).not.toMatch(/<figcaption>\s*(?:图片|图)\s*\d+/)
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

describe('guarded CSDN draft adapter', () => {
  const csdnDraftAuthorization = { action: 'saveDraft' as const, platform: 'csdn' as const, taskId: 'tsk_12345678_cafebabe', snapshotId: 'snap-cccccccccccccccccccccccc' }

  it('saves a draft whose markdown image urls come from the uploaded html, then passes readback', async () => {
    let savedBody: any = null
    const adapter = new CSDNAdapter()
    await adapter.init(zhihuRuntime(async (url, options) => {
      if (url.includes('/v3/editor/getBaseInfo')) return new Response(JSON.stringify({ code: 200, data: { name: 'tester', nickname: '验收号', avatar: '', blog_url: '' } }), { status: 200 })
      if (url.includes('/resource-api/v1/image/direct/upload/signature')) {
        return new Response(JSON.stringify({ code: 400, message: 'no upload in test' }), { status: 200 })
      }
      if (url.includes('/mdeditor/saveArticle') && options?.method === 'POST') {
        savedBody = JSON.parse(String(options.body))
        return new Response(JSON.stringify({ code: 200, data: { id: '165717534' } }), { status: 200 })
      }
      if (url.includes('/v3/editor/getArticle') && options?.method === 'GET') {
        return new Response(JSON.stringify({ code: 200, data: { title: savedBody.title, content: savedBody.content, markdowncontent: savedBody.markdowncontent } }), { status: 200 })
      }
      return new Response('{}', { status: 404 })
    }))
    const html = '<p>前文</p><p style="text-align:center;"><img src="https://img.mp.sohu.com/test.png" alt="CSDN图片注释"></p><h2>一、标题</h2><p><strong>后文</strong></p>'
    const result = await adapter.saveDraft({ title: 'CSDN 测试', html, markdown: '' }, { draftOnly: true, draftAuthorization: csdnDraftAuthorization, onDraftStage: () => {} })
    expect(result.success).toBe(true)
    expect(result.fidelityVerified).toBe(true)
    // 图片未在 CSDN 上传成功时保留原 URL,但 markdown 中必须存在图片行且 URL 与 HTML 一致
    expect(savedBody.markdowncontent).toContain('![CSDN图片注释](https://img.mp.sohu.com/test.png)')
    expect(savedBody.markdowncontent).not.toContain('<img')
    expect(savedBody.markdowncontent).toContain('## 一、标题')
  })

  it('reports failure when the editor detail endpoint returns 404', async () => {
    const adapter = new CSDNAdapter()
    await adapter.init(zhihuRuntime(async (url, options) => {
      if (url.includes('/v3/editor/getBaseInfo')) return new Response(JSON.stringify({ code: 200, data: { name: 'tester', nickname: '验收号', avatar: '', blog_url: '' } }), { status: 200 })
      if (url.includes('/mdeditor/saveArticle')) return new Response(JSON.stringify({ code: 200, data: { id: '165717534' } }), { status: 200 })
      if (url.includes('/v3/editor/getArticle')) return new Response('not found', { status: 404 })
      return new Response('{}', { status: 404 })
    }))
    const result = await adapter.saveDraft({ title: 'CSDN 测试', html: '<p>正文</p>', markdown: '' }, { draftOnly: true, draftAuthorization: csdnDraftAuthorization, onDraftStage: () => {} })
    expect(result.success).toBe(false)
    expect(result.error).toContain('回读失败: 404')
  })
})
