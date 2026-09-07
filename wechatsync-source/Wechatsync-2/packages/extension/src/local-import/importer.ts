import DOMPurify from 'dompurify'
import { marked } from 'marked'
import mammoth from 'mammoth/mammoth.browser'

export const MAX_DOCUMENT_BYTES = 15 * 1024 * 1024
export const MAX_CONTENT_BYTES = 24 * 1024 * 1024
export const documentFile = (f: File) => /\.(md|markdown|html?|docx)$/i.test(f.name)
export const imageFile = (f: File) => /\.(png|jpe?g|gif|webp)$/i.test(f.name)
export const filePath = (f: File) => f.webkitRelativePath || f.name

export function normalizePath(value: string): string {
  let path = value.replace(/\\/g, '/')
  try { path = decodeURIComponent(path) } catch { /* literal percent in filename */ }
  const segments: string[] = []
  for (const part of path.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') segments.pop()
    else segments.push(part)
  }
  return segments.join('/').normalize('NFC').toLowerCase()
}

// Resolve only explicitly selected files. Never read arbitrary absolute paths.
export function resolveImage(src: string, documentPath: string, files: File[]): File | undefined {
  const clean = src.replace(/[?#].*$/, '')
  const relative = normalizePath(`${documentPath.replace(/[^/\\]*$/, '')}${clean}`)
  const direct = normalizePath(clean.replace(/^file:\/*/i, ''))
  const images = files.filter(imageFile)
  for (const key of [relative, direct]) {
    const exact = images.filter(f => normalizePath(filePath(f)) === key)
    if (exact.length === 1) return exact[0]
    if (exact.length > 1) return undefined
  }
  const name = normalizePath(clean).split('/').pop()
  const fallback = images.filter(f => normalizePath(f.name) === name)
  return fallback.length === 1 ? fallback[0] : undefined
}

async function dataUrl(file: File): Promise<string> {
  if (file.size > MAX_DOCUMENT_BYTES) throw new Error(`图片超过15MB：${file.name}`)
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error(`无法读取图片：${file.name}`))
    reader.readAsDataURL(file)
  })
}

export function sanitizeHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: ['p', 'div', 'section', 'article', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'br', 'hr', 'strong', 'b', 'em', 'i', 'u', 's', 'del', 'span', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'figure', 'figcaption', 'img', 'a', 'sup', 'sub'],
    ALLOWED_ATTR: ['src', 'alt', 'title', 'href', 'colspan', 'rowspan', 'start'],
    ALLOW_DATA_ATTR: false,
  })
}

export interface ImportedArticle {
  title: string
  html: string
  imageCount: number
  missing: string[]
  warnings: string[]
}

export async function importDocument(file: File, files: File[]): Promise<ImportedArticle> {
  if (!documentFile(file)) throw new Error('请选择 .docx、.md、.markdown 或 .html 文件；旧版 .doc 请先另存为 .docx。')
  if (file.size > MAX_DOCUMENT_BYTES) throw new Error('文章文件超过15MB，请先压缩图片。')
  const warnings: string[] = []
  let html = ''
  let metadataTitle = ''
  const buffer = await file.arrayBuffer()
  if (/\.docx$/i.test(file.name)) {
    const result = await mammoth.convertToHtml({ arrayBuffer: buffer }, {
      convertImage: mammoth.images.imgElement(async image => ({
        src: `data:${image.contentType};base64,${await image.read('base64')}`,
      })),
    })
    html = result.value
    warnings.push(...result.messages.map(m => m.message))
    warnings.push('Word按文章结构转换，字体、分页和复杂排版可能变化，请检查预览。')
  } else {
    let text: string
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer) }
    catch { text = new TextDecoder('gb18030').decode(buffer); warnings.push('已按GB18030读取，请核对中文是否正确。') }
    if (/\.markdown$|\.md$/i.test(file.name)) {
      const front = text.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)
      if (front) {
        metadataTitle = front[1].match(/^title:\s*["']?(.+?)["']?\s*$/m)?.[1] || ''
        text = text.slice(front[0].length)
      }
      html = await marked.parse(text)
    } else {
      // DOMParser is inert, but remove resource-bearing tags before parsing.
      const clean = sanitizeHtml(text)
      html = clean
    }
  }
  if (html.length > MAX_CONTENT_BYTES) throw new Error('解码后文章和图片过大，请压缩配图后再导入。')
  const doc = new DOMParser().parseFromString(sanitizeHtml(html), 'text/html')
  const title = metadataTitle || doc.querySelector('h1')?.textContent?.trim() || file.name.replace(/\.[^.]+$/, '')
  const missing: string[] = []
  const cache = new Map<File, string>()
  let contentBytes = html.length
  for (const img of Array.from(doc.querySelectorAll('img'))) {
    const src = img.getAttribute('src') || ''
    if (/^data:image\/(png|jpeg|gif|webp);base64,[a-z0-9+/=\s]+$/i.test(src)) continue
    const local = resolveImage(src, filePath(file), files)
    if (!local) {
      missing.push(src || '(无图片地址)')
      img.removeAttribute('src')
      continue
    }
    let data = cache.get(local)
    if (!data) { data = await dataUrl(local); cache.set(local, data) }
    if (!/^data:image\/(png|jpeg|gif|webp);base64,/i.test(data)) {
      // Some file pickers omit MIME types; derive it only for accepted extensions.
      const ext = local.name.split('.').pop()!.toLowerCase()
      const mime = ext === 'jpg' ? 'jpeg' : ext
      data = data.replace(/^data:[^;]*;/, `data:image/${mime};`)
    }
    contentBytes += data.length
    if (contentBytes > MAX_CONTENT_BYTES) throw new Error('正文和内嵌图片超过24MB，请压缩配图。')
    img.setAttribute('src', data)
  }
  for (const a of Array.from(doc.querySelectorAll('a'))) {
    if (!/^https?:\/\//i.test(a.getAttribute('href') || '')) a.removeAttribute('href')
  }
  if (!doc.body.textContent?.trim() && !doc.querySelector('img')) throw new Error('文件里没有可同步的正文。')
  return { title, html: doc.body.innerHTML, imageCount: doc.querySelectorAll('img').length, missing, warnings }
}

export function withoutDuplicateTitle(html: string, title: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const first = doc.body.firstElementChild
  if (first?.tagName === 'H1' && first.textContent?.trim() === title.trim()) first.remove()
  return doc.body.innerHTML
}

export function previewDocument(html: string): string {
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"><style>body{font:16px/1.8 system-ui;padding:24px;color:#172033}img{max-width:100%;height:auto;display:block;margin:16px auto}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:8px}pre{white-space:pre-wrap}a{pointer-events:none}</style></head><body>${sanitizeHtml(html)}</body></html>`
}
