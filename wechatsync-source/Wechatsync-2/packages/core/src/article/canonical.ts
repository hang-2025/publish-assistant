import { parseHTML } from 'linkedom'

export const ZHIHU_CAPTION_POLICY_MAX_LENGTH = 140

export type FidelityStatus = 'PASS' | 'DEGRADED' | 'UNSUPPORTED' | 'FAIL'

export type CanonicalBlock =
  | { kind: 'heading'; level: 1 | 2 | 3; text: string; html: string }
  | { kind: 'paragraph'; text: string; html: string }
  | { kind: 'list'; ordered: boolean; text: string; html: string }
  | { kind: 'quote'; text: string; html: string }
  | { kind: 'table'; text: string; html: string }
  | { kind: 'image'; source: string; alt: string; captionCandidate: string; order: number; anchor: number }
  | { kind: 'divider' }

export interface CanonicalArticle {
  schema: 'yizao-canonical-article'
  version: 1
  title: string
  blocks: CanonicalBlock[]
  images: Array<Extract<CanonicalBlock, { kind: 'image' }>>
  sourceImageCount: number
}

export interface FidelityCheck {
  key: string
  status: FidelityStatus
  required: boolean
  detail: string
}

export interface FidelityReport {
  schema: 'yizao-html-fidelity-report'
  version: 1
  overall: FidelityStatus
  fidelityVerified: boolean
  checks: FidelityCheck[]
  summary: { pass: number; degraded: number; unsupported: number; fail: number }
}

const normalize = (value: string) => value.replace(/\s+/g, ' ').trim()
const escapeAttr = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
const IMAGE_ORDINAL = '(?:[0-9０-９]+|[一二三四五六七八九十百零〇两]+)'
const IMAGE_ORDINAL_PREFIX = new RegExp(
  `^(?:(?:图片|图)\\s*(?:第\\s*)?${IMAGE_ORDINAL}\\s*(?:张)?|第\\s*${IMAGE_ORDINAL}\\s*张(?:图片|图))\\s*[：:、.．\\-—]\\s*`,
)

/** Remove packaging-only labels such as “图片1：” from user-visible ALT captions. */
export function visibleImageAlt(value: string): string {
  return normalize(value).replace(IMAGE_ORDINAL_PREFIX, '').trim()
}

function semanticHtml(element: Element): string {
  const clone = element.cloneNode(true) as Element
  for (const item of Array.from(clone.querySelectorAll('*'))) {
    for (const attr of Array.from(item.attributes)) {
      if (!['href', 'colspan', 'rowspan', 'start'].includes(attr.name)) item.removeAttribute(attr.name)
    }
  }
  return clone.innerHTML
}

/** Parse the publishing-package HTML into a platform-neutral block model. */
export function parseCanonicalArticle(html: string, title = ''): CanonicalArticle {
  const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`)
  const blocks: CanonicalBlock[] = []
  let imageOrder = 0
  let anchor = 0

  const pushImage = (img: Element) => {
    const alt = visibleImageAlt(img.getAttribute('alt') || '')
    blocks.push({
      kind: 'image', source: img.getAttribute('src') || '', alt,
      captionCandidate: alt, order: ++imageOrder, anchor,
    })
  }
  const walk = (element: Element) => {
    const tag = element.tagName.toLowerCase()
    if (tag === 'img') { pushImage(element); return }
    if (tag === 'figure') {
      for (const img of Array.from(element.querySelectorAll('img'))) pushImage(img)
      return
    }
    // 头条号回读使用 div.pgc-img + p.pgc-img-caption 表示图片块。
    // 将整个容器视为一个图片块，避免把可见图注误计为正文段落。
    if (tag === 'div' && element.classList.contains('pgc-img')) {
      for (const img of Array.from(element.querySelectorAll('img'))) pushImage(img)
      return
    }
    // 网易号编辑器把图片与可见说明保存为 p > img + br + text。
    // 整体按一个图片块回读，避免把说明误算为正文段落而破坏锚点。
    if (tag === 'p' && element.querySelector(':scope > img') && element.querySelector(':scope > br')) {
      for (const img of Array.from(element.querySelectorAll(':scope > img'))) pushImage(img)
      return
    }
    // 搜狐编辑器（Quill 定制）的图片描述是 p > img + span.img-desc。
    // 同样整体视为一个图片块，img-desc 的可见文字不重复计入正文。
    if (tag === 'p' && element.querySelector(':scope > img') && element.querySelector(':scope > .img-desc')) {
      for (const img of Array.from(element.querySelectorAll(':scope > img'))) pushImage(img)
      return
    }
    if (/^h[1-6]$/.test(tag)) {
      blocks.push({ kind: 'heading', level: Math.min(3, Number(tag[1])) as 1 | 2 | 3, text: normalize(element.textContent || ''), html: semanticHtml(element) }); anchor++; return
    }
    if (tag === 'p') {
      const directImages = Array.from(element.children).filter((child) => child.tagName.toLowerCase() === 'img')
      if (directImages.length) {
        let fragment = ''
        for (const node of Array.from(element.childNodes)) {
          if (node.nodeType === 1 && (node as Element).tagName.toLowerCase() === 'img') {
            if (normalize(fragment.replace(/<[^>]+>/g, ' '))) { blocks.push({ kind: 'paragraph', text: normalize(fragment.replace(/<[^>]+>/g, ' ')), html: fragment }); anchor++ }
            fragment = ''; pushImage(node as Element)
          } else fragment += node.nodeType === 3 ? node.textContent || '' : (node as Element).outerHTML
        }
        if (normalize(fragment.replace(/<[^>]+>/g, ' '))) { blocks.push({ kind: 'paragraph', text: normalize(fragment.replace(/<[^>]+>/g, ' ')), html: fragment }); anchor++ }
      } else { blocks.push({ kind: 'paragraph', text: normalize(element.textContent || ''), html: semanticHtml(element) }); anchor++ }
      return
    }
    if (tag === 'ul' || tag === 'ol') { blocks.push({ kind: 'list', ordered: tag === 'ol', text: normalize(element.textContent || ''), html: element.outerHTML }); anchor++; return }
    if (tag === 'blockquote') { blocks.push({ kind: 'quote', text: normalize(element.textContent || ''), html: semanticHtml(element) }); anchor++; return }
    if (tag === 'table') { blocks.push({ kind: 'table', text: normalize(element.textContent || ''), html: element.outerHTML }); anchor++; return }
    if (tag === 'hr') { blocks.push({ kind: 'divider' }); anchor++; return }
    for (const child of Array.from(element.children)) walk(child)
    if (!element.children.length && normalize(element.textContent || '')) {
      blocks.push({ kind: 'paragraph', text: normalize(element.textContent || ''), html: semanticHtml(element) }); anchor++
    }
  }
  for (const child of Array.from(document.body.children)) walk(child)
  const images = blocks.filter((block): block is Extract<CanonicalBlock, { kind: 'image' }> => block.kind === 'image')
  return { schema: 'yizao-canonical-article', version: 1, title: normalize(title), blocks, images, sourceImageCount: document.querySelectorAll('img').length }
}

export function assertCaptionPolicy(article: CanonicalArticle, maxLength = ZHIHU_CAPTION_POLICY_MAX_LENGTH): void {
  if (article.images.length !== article.sourceImageCount) {
    throw new Error('HTML 包含当前 Canonical Article 尚不能安全保持锚点的嵌套图片，已阻止保存')
  }
  for (const image of article.images) {
    if (!image.alt) throw new Error(`第 ${image.order} 张图片缺少 HTML img.alt，不能生成可见图注`)
    if (Array.from(image.alt).length > maxLength) {
      throw new Error(`第 ${image.order} 张图片的 HTML img.alt 超过当前平台验收策略上限 ${maxLength} 字，已阻止保存；不会静默截断`)
    }
  }
}

/** Render only canonical semantics. Every image caption is derived from its HTML alt. */
export function renderCanonicalArticle(article: CanonicalArticle): string {
  return article.blocks.map((block) => {
    if (block.kind === 'heading') return `<h${block.level}>${block.html}</h${block.level}>`
    if (block.kind === 'paragraph') return `<p>${block.html}</p>`
    if (block.kind === 'list' || block.kind === 'table') return block.html
    if (block.kind === 'quote') return `<blockquote>${block.html}</blockquote>`
    if (block.kind === 'divider') return '<hr>'
    return `<figure><img src="${escapeAttr(block.source)}" alt="${escapeAttr(block.alt)}"><figcaption>${escapeAttr(block.captionCandidate)}</figcaption></figure>`
  }).join('')
}

/**
 * Remove visual divider blocks for platforms whose editor renders package
 * separators as prominent horizontal rules. Image anchors are recalculated so
 * the platform-normalized article can still be verified after read-back.
 */
export function withoutCanonicalDividers(article: CanonicalArticle): CanonicalArticle {
  let anchor = 0
  let imageOrder = 0
  const blocks: CanonicalBlock[] = []

  for (const block of article.blocks) {
    if (block.kind === 'divider') continue
    if (block.kind === 'image') {
      blocks.push({ ...block, order: ++imageOrder, anchor })
      continue
    }
    blocks.push(block)
    anchor++
  }

  const images = blocks.filter((block): block is Extract<CanonicalBlock, { kind: 'image' }> => block.kind === 'image')
  return { ...article, blocks, images }
}

function sequence(article: CanonicalArticle) {
  // Required check is text and main-block order. Structural tag fidelity is
  // reported separately so a platform-normalized list/quote can be DEGRADED.
  return article.blocks.filter((b) => b.kind !== 'image' && b.kind !== 'divider').map((b) => normalize('text' in b ? b.text : ''))
}
function feature(article: CanonicalArticle, kind: CanonicalBlock['kind']) { return article.blocks.filter((block) => block.kind === kind) }
function add(checks: FidelityCheck[], key: string, ok: boolean, required: boolean, detail: string, degraded = false) {
  checks.push({ key, status: ok ? 'PASS' : degraded ? 'DEGRADED' : 'FAIL', required, detail })
}

export function validateCanonicalFidelity(source: CanonicalArticle, readBackHtml: string, readBackTitle: string): FidelityReport {
  const actual = parseCanonicalArticle(readBackHtml, readBackTitle)
  const checks: FidelityCheck[] = []
  add(checks, 'title', source.title === actual.title, true, source.title === actual.title ? '标题一致' : '标题不一致')
  add(checks, 'main-block-order', JSON.stringify(sequence(source)) === JSON.stringify(sequence(actual)), true, '正文主块文字与顺序校验')
  const sourceHeadings = feature(source, 'heading').map((b) => `${(b as Extract<CanonicalBlock, { kind: 'heading' }>).level}:${(b as any).text}`)
  const actualHeadings = feature(actual, 'heading').map((b) => `${(b as Extract<CanonicalBlock, { kind: 'heading' }>).level}:${(b as any).text}`)
  add(checks, 'heading-levels', JSON.stringify(sourceHeadings) === JSON.stringify(actualHeadings), false, 'H1-H3 层级映射', true)
  for (const kind of ['list', 'quote'] as const) {
    const expected = feature(source, kind).map((b) => (b as any).text)
    const observed = feature(actual, kind).map((b) => (b as any).text)
    add(checks, kind, JSON.stringify(expected) === JSON.stringify(observed), false, `${kind} 语义结构`, true)
  }
  const inlineSemantics = (value: CanonicalArticle, selector: string) => {
    const html = value.blocks.map((block) => 'html' in block ? block.html : '').join('')
    const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`)
    return Array.from(document.querySelectorAll(selector)).map((item) => normalize(item.textContent || ''))
  }
  const sourceMarks = [...inlineSemantics(source, 'strong,b').map((text) => `strong:${text}`), ...inlineSemantics(source, 'em,i').map((text) => `em:${text}`)]
  const actualMarks = [...inlineSemantics(actual, 'strong,b').map((text) => `strong:${text}`), ...inlineSemantics(actual, 'em,i').map((text) => `em:${text}`)]
  add(checks, 'inline-emphasis', JSON.stringify(sourceMarks) === JSON.stringify(actualMarks), true, 'strong/emphasis 语义与顺序')
  const links = (value: CanonicalArticle) => {
    const html = value.blocks.map((block) => 'html' in block ? block.html : '').join('')
    const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`)
    return Array.from(document.querySelectorAll('a')).map((item) => `${item.getAttribute('href') || ''}:${normalize(item.textContent || '')}`)
  }
  add(checks, 'links', JSON.stringify(links(source)) === JSON.stringify(links(actual)), false, '链接地址、文字与顺序', true)
  const tables = feature(source, 'table').map((b) => (b as any).text)
  const actualTables = feature(actual, 'table').map((b) => (b as any).text)
  add(checks, 'tables', JSON.stringify(tables) === JSON.stringify(actualTables), false, '表格单元格语义；样式不属于保真承诺', true)
  const { document } = parseHTML(`<!doctype html><html><body>${readBackHtml}</body></html>`)
  const captions = Array.from(document.querySelectorAll('img')).map((img) => normalize(
    img.getAttribute('data-caption')
      || img.closest('figure')?.querySelector('figcaption')?.textContent
      || img.closest('.pgc-img')?.querySelector('.pgc-img-caption')?.textContent
      || (img.parentElement?.tagName.toLowerCase() === 'p' && img.parentElement.querySelector(':scope > br')
        ? Array.from(img.parentElement.childNodes).slice(Array.from(img.parentElement.childNodes).findIndex((node) => node === img) + 1).map((node) => node.textContent || '').join(' ')
        : '')
      || ''
  ))
  add(checks, 'image-count', source.images.length === actual.images.length, true, `源 ${source.images.length} / 回读 ${actual.images.length}`)
  // Zhihu may not expose a distinct accessibility ALT field. Visible captions
  // are mandatory and provide the stable, user-visible order identity.
  add(checks, 'image-order', JSON.stringify(source.images.map((i) => i.alt)) === JSON.stringify(captions), true, '按源 HTML alt 生成的可见 Caption 对照图片顺序')
  add(checks, 'image-anchor', JSON.stringify(source.images.map((i) => i.anchor)) === JSON.stringify(actual.images.map((i) => i.anchor)), true, '图片相对正文块锚点')
  add(checks, 'caption-equals-html-alt', JSON.stringify(captions) === JSON.stringify(source.images.map((i) => i.alt)), true, '每张图可见 Caption 必须等于源 HTML img.alt')
  const summary = { pass: 0, degraded: 0, unsupported: 0, fail: 0 }
  for (const check of checks) summary[check.status.toLowerCase() as keyof typeof summary]++
  const fidelityVerified = checks.every((check) => !check.required || check.status === 'PASS')
  return { schema: 'yizao-html-fidelity-report', version: 1, overall: !fidelityVerified ? 'FAIL' : summary.degraded ? 'DEGRADED' : 'PASS', fidelityVerified, checks, summary }
}

/** 压缩空白后的正文文本，用于平台重排段落后的稳定对照。 */
export function compactCanonicalText(value: string): string {
  return String(value || '').replace(/[\s\u200B-\u200D\uFEFF]+/g, '')
}

/** 定位两段压缩正文的第一个字符差异，用于失败时诊断平台改写位置。 */
export function firstCanonicalTextDivergence(source: string, actual: string): string {
  const limit = Math.min(source.length, actual.length)
  let index = 0
  while (index < limit && source[index] === actual[index]) index += 1
  const around = (value: string) => JSON.stringify(value.slice(Math.max(0, index - 10), index + 30))
  return `首个差异@${index}（长度 源${source.length}/回读${actual.length}）：源${around(source)} 回读${around(actual)}`
}

function canonicalTextOf(article: CanonicalArticle): string {
  return compactCanonicalText(article.blocks
    .filter((block) => block.kind !== 'image' && block.kind !== 'divider')
    .map((block) => 'text' in block ? block.text : '')
    .join(''))
}

function canonicalImageOffsets(article: CanonicalArticle): number[] {
  let offset = 0
  const result: number[] = []
  for (const block of article.blocks) {
    if (block.kind === 'image') result.push(offset)
    else if (block.kind !== 'divider' && 'text' in block) offset += compactCanonicalText(block.text).length
  }
  return result
}

/**
 * 面向「平台会合并/拆分段落」的编辑器（网易号/搜狐号/CSDN 等）的保真校验：
 * 正文顺序按压缩文本全等对照，图片锚点按每张图片前累计正文字符位置核对；
 * 其余检查沿用 canonical 严格语义。
 */
export function validateWithCharOffsetFidelity(source: CanonicalArticle, readBackHtml: string, readBackTitle: string, platformLabel: string): FidelityReport {
  const report = validateCanonicalFidelity(source, readBackHtml, readBackTitle)
  const actual = parseCanonicalArticle(readBackHtml, readBackTitle)
  const sourceText = canonicalTextOf(source)
  const actualText = canonicalTextOf(actual)
  const sourceOffsets = canonicalImageOffsets(source)
  const actualOffsets = canonicalImageOffsets(actual)
  const replace = (key: string, ok: boolean, detail: string) => {
    const check = report.checks.find((item) => item.key === key)
    if (check) { check.status = ok ? 'PASS' : 'FAIL'; check.detail = detail }
  }
  replace('main-block-order', sourceText === actualText,
    sourceText === actualText ? `正文文字与顺序一致；允许${platformLabel}合并或拆分 HTML 段落` : `正文文字存在差异；${firstCanonicalTextDivergence(sourceText, actualText)}`)
  replace('image-anchor', JSON.stringify(sourceOffsets) === JSON.stringify(actualOffsets),
    JSON.stringify(sourceOffsets) === JSON.stringify(actualOffsets)
      ? `按每张图片前累计正文字符位置核对；允许${platformLabel}重排段落`
      : `图片锚点不一致；锚点 源=${JSON.stringify(sourceOffsets)} 回读=${JSON.stringify(actualOffsets)}`)
  report.summary = { pass: 0, degraded: 0, unsupported: 0, fail: 0 }
  for (const check of report.checks) report.summary[check.status.toLowerCase() as keyof typeof report.summary]++
  report.fidelityVerified = report.checks.every((check) => !check.required || check.status === 'PASS')
  report.overall = report.fidelityVerified ? (report.summary.degraded ? 'DEGRADED' : 'PASS') : 'FAIL'
  return report
}

/**
 * 平台编辑器顶部标题栏由接口的 title 字段承担；正文里再放一个相同文字的
 * 大标题会在文章页显示两遍。在保存与校验两侧对称地移除该重复标题块。
 */
export function stripDuplicateTitleBlock(article: CanonicalArticle, title: string): void {
  const first = article.blocks[0]
  if (!first || first.kind !== 'heading') return
  const drop = (value: string) => value.replace(/[？?！!。:：\s]+$/g, '')
  if (drop(first.text) === drop(title) || drop(title).startsWith(drop(first.text))) article.blocks.shift()
}
