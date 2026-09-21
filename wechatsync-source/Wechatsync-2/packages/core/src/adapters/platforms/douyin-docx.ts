import JSZip from 'jszip'
import { parseHTML } from 'linkedom'
import type { CanonicalArticle, CanonicalBlock } from '../../article/canonical'

type EmbeddedImage = {
  relationshipId: string
  filename: string
  contentType: string
  base64: string
  alt: string
  order: number
}

const xml = (value: string) => String(value || '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;')

function imageFromDataUrl(block: Extract<CanonicalBlock, { kind: 'image' }>, index: number): EmbeddedImage {
  const match = block.source.match(/^data:(image\/(?:png|jpe?g|gif|bmp));base64,([A-Za-z0-9+/=\s]+)$/i)
  if (!match) throw new Error(`第 ${block.order} 张图片不是可嵌入的 PNG/JPEG/GIF/BMP 数据，已阻止抖音导入`)
  const normalizedType = match[1].toLowerCase().replace('jpg', 'jpeg')
  const extension = normalizedType === 'image/jpeg' ? 'jpg' : normalizedType.split('/')[1]
  return {
    relationshipId: `rIdImage${index + 1}`,
    filename: `image${index + 1}.${extension}`,
    contentType: normalizedType,
    base64: match[2].replace(/\s+/g, ''),
    alt: block.alt,
    order: block.order,
  }
}

function runsFromHtml(html: string): string {
  const { document } = parseHTML(`<!doctype html><html><body><p>${html}</p></body></html>`)
  const output: string[] = []
  const walk = (node: Node, bold = false, italic = false) => {
    if (node.nodeType === 3) {
      const value = node.textContent || ''
      if (!value) return
      const properties = `${bold ? '<w:b/>' : ''}${italic ? '<w:i/>' : ''}`
      output.push(`<w:r>${properties ? `<w:rPr>${properties}</w:rPr>` : ''}<w:t xml:space="preserve">${xml(value)}</w:t></w:r>`)
      return
    }
    if (node.nodeType !== 1) return
    const element = node as Element
    const tag = element.tagName.toLowerCase()
    if (tag === 'br') { output.push('<w:r><w:br/></w:r>'); return }
    for (const child of Array.from(element.childNodes)) walk(child, bold || tag === 'strong' || tag === 'b', italic || tag === 'em' || tag === 'i')
  }
  for (const child of Array.from(document.body.firstElementChild?.childNodes || [])) walk(child)
  return output.join('') || '<w:r><w:t></w:t></w:r>'
}

function textParagraph(text: string, style?: string): string {
  const properties = style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''
  return `<w:p>${properties}<w:r><w:t xml:space="preserve">${xml(text)}</w:t></w:r></w:p>`
}

function blockParagraph(block: Exclude<CanonicalBlock, { kind: 'image' | 'divider' }>): string {
  if (block.kind === 'heading') return `<w:p><w:pPr><w:pStyle w:val="Heading${block.level}"/></w:pPr>${runsFromHtml(block.html)}</w:p>`
  if (block.kind === 'paragraph') return `<w:p>${runsFromHtml(block.html)}</w:p>`
  if (block.kind === 'quote') return `<w:p><w:pPr><w:ind w:left="420"/></w:pPr>${runsFromHtml(block.html)}</w:p>`
  // 复杂列表/表格交给抖音重新排版；这里保留完整可见文字，且不凭空增加符号。
  return textParagraph(block.text)
}

function imageParagraph(image: EmbeddedImage): string {
  const drawingId = 100 + image.order
  return `<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="5486400" cy="3657600"/><wp:docPr id="${drawingId}" name="${xml(image.filename)}" descr="${xml(image.alt)}"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${drawingId}" name="${xml(image.filename)}" descr="${xml(image.alt)}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${image.relationshipId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="5486400" cy="3657600"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`
}

/** Build an OOXML Word document for Douyin's official “一键导入” control. */
export async function buildDouyinImportDocx(article: CanonicalArticle): Promise<string> {
  const zip = new JSZip()
  const images = article.images.map(imageFromDataUrl)
  const byOrder = new Map(images.map((image) => [image.order, image]))
  const body = article.blocks.map((block) => {
    if (block.kind === 'divider') return ''
    if (block.kind !== 'image') return blockParagraph(block)
    const image = byOrder.get(block.order)
    if (!image) throw new Error(`第 ${block.order} 张图片未能写入抖音导入文件`)
    // 图片说明由抖音编辑器自己的“图片描述”字段承载；不要在 DOCX 中再
    // 生成普通正文段落，否则平台会显示一份正文说明、描述框却仍为空。
    return imageParagraph(image)
  }).join('')

  const imageTypes = Array.from(new Map(images.map((image) => [image.filename.split('.').pop(), image.contentType])))
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${imageTypes.map(([extension, type]) => `<Default Extension="${extension}" ContentType="${type}"/>`).join('')}<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`)
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`)
  zip.file('word/_rels/document.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>${images.map((image) => `<Relationship Id="${image.relationshipId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${image.filename}"/>`).join('')}</Relationships>`)
  zip.file('word/styles.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:rPr><w:sz w:val="22"/></w:rPr></w:style>${[1, 2, 3].map((level) => `<w:style w:type="paragraph" w:styleId="Heading${level}"><w:name w:val="heading ${level}"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:sz w:val="${34 - level * 4}"/></w:rPr></w:style>`).join('')}</w:styles>`)
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`)
  for (const image of images) zip.file(`word/media/${image.filename}`, image.base64, { base64: true })
  return zip.generateAsync({ type: 'base64', compression: 'DEFLATE', compressionOptions: { level: 6 } })
}
