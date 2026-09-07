import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { importDocument, resolveImage, sanitizeHtml, previewDocument, withoutDuplicateTitle } from '../src/local-import/importer'
import { CodeAdapter } from '../../core/src/adapters/code-adapter'
import { ZhihuAdapter } from '../../core/src/adapters/platforms/zhihu'
import { preprocessForMultiplePlatforms } from '../src/lib/content-processor'
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
