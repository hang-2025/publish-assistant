import { zipStore, unzip } from './zip.mjs';

/**
 * 最小 .xlsx 读写（无第三方依赖，阶段1B：只读映射原型 + 模拟夹具）。
 *
 * - 生成：仅用于新建模拟夹具（绝不读取/写入用户真实表格）；
 * - 读取：解析 workbook 工作表名、sharedStrings / inlineStr / 数字 / 布尔单元格，
 *   兼容 Excel 导出的 store 与 deflate 两种 zip 压缩；输出为二维字符串矩阵。
 * - 所有解析都在内存中完成，带条目/大小防护，不落盘、不留日志。
 */

const ENC = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
function esc(v) {
  return String(v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
function escAttr(v) { return esc(v).replace(/\r\n?|\n/g, '&#10;'); }

function colRef(col) {
  let s = '';
  let n = col + 1;
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

function parseCol(ref) {
  const m = String(ref).match(/^([A-Z]+)\d+$/);
  if (!m) return 0;
  let n = 0;
  for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}
function parseRow(ref) {
  const m = String(ref).match(/^[A-Z]+(\d+)$/);
  return m ? Number(m[1]) - 1 : 0;
}

/** XML 文本节点简易提取（我们的写入器与 Excel 风格都足够简单）。 */
function xmlText(xml) {
  return xml
    .replace(/<[^>]*>/g, '') // 去标签
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#10;|&#xA;/g, '\n');
}

function extractSharedStrings(xml) {
  const out = [];
  // 每个 <si>...</si>
  const siRe = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let m;
  while ((m = siRe.exec(xml)) !== null) {
    const inner = m[1];
    let text = '';
    // rich text: <r><t>..</t></r>；普通：<t>..</t>。取所有 t 内容拼接。
    const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>|<t\b[^>]*\/>/g;
    let tm;
    while ((tm = tRe.exec(inner)) !== null) text += xmlText(tm[1] ?? '');
    out.push(text);
  }
  return out;
}

/** 解析一个工作表 XML → 二维字符串矩阵（按实际用到的行列裁剪）。 */
function parseSheet(xml, shared) {
  const cells = [];
  const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
  let m;
  while ((m = cellRe.exec(xml)) !== null) {
    const attrs = m[1] || '';
    const refMatch = attrs.match(/\br="([A-Z]+\d+)"/);
    if (!refMatch) continue;
    const typeMatch = attrs.match(/\bt="([a-zA-Z]+)"/);
    const type = typeMatch ? typeMatch[1] : '';
    const inner = m[2] ?? '';
    const col = parseCol(refMatch[1]);
    const row = parseRow(refMatch[1]);
    let value = '';
    if (type === 's') {
      const v = inner.match(/<v>([\s\S]*?)<\/v>/);
      value = v ? (shared[Number(v[1])] ?? '') : '';
    } else if (type === 'inlineStr') {
      const is = inner.match(/<is\b[^>]*>([\s\S]*?)<\/is>/);
      value = is ? xmlText(is[1]) : '';
    } else if (type === 'b') {
      const v = inner.match(/<v>([\s\S]*?)<\/v>/);
      value = v && v[1] === '1' ? 'TRUE' : 'FALSE';
    } else if (type === 'str' || type === 'e') {
      const v = inner.match(/<v>([\s\S]*?)<\/v>/);
      value = v ? xmlText(v[1]) : '';
    } else {
      // 默认数字
      const v = inner.match(/<v>([\s\S]*?)<\/v>/);
      value = v ? String(Number(v[1])) : '';
    }
    if (!cells[row]) cells[row] = [];
    cells[row][col] = value;
  }
  const maxRow = cells.reduce((n, r, i) => (r && r.some((c) => c !== '' && c !== undefined) ? i : n), -1);
  const rows = [];
  for (let r = 0; r <= maxRow; r += 1) {
    const src = cells[r] || [];
    let maxCol = -1;
    for (let c = src.length - 1; c >= 0; c -= 1) { if (src[c] !== '' && src[c] !== undefined) { maxCol = c; break; } }
    const outRow = [];
    for (let c = 0; c <= maxCol; c += 1) outRow.push(src[c] ?? '');
    rows.push(outRow);
  }
  return rows;
}

/**
 * 读取 .xlsx buffer → { sheets: [{ name, rows: string[][] }] }
 */
export function readXlsx(buffer) {
  const files = unzip(buffer);
  const workbookXml = files.get('xl/workbook.xml');
  if (!workbookXml) throw new Error('不是有效的 .xlsx（缺少 xl/workbook.xml）');
  const wbText = workbookXml.toString('utf8');
  const names = [];
  const sheetRe = /<sheet\b[^>]*>/g;
  let sm;
  while ((sm = sheetRe.exec(wbText)) !== null) {
    const name = sm[0].match(/\bname="([^"]*)"/)?.[1] ?? '';
    if (name) names.push(name);
  }
  // sheet → 文件映射：优先 workbook.xml.rels，失败则按 sheet 顺序找 sheetN.xml
  const rels = files.get('xl/_rels/workbook.xml.rels')?.toString('utf8') || '';
  const relMap = [];
  const relRe = /<Relationship\b[^>]*\/?>/g;
  let rm;
  while ((rm = relRe.exec(rels)) !== null) {
    const id = rm[0].match(/\bId="([^"]*)"/)?.[1] ?? '';
    const target = rm[0].match(/\bTarget="([^"]*)"/)?.[1] ?? '';
    if (id && target) relMap.push([id, target]);
  }
  const sheets = names.map((name, i) => {
    const target = relMap.find(([id]) => id === `rId${i + 1}`)?.[1]
      || (i === 0 ? 'worksheets/sheet1.xml' : `worksheets/sheet${i + 1}.xml`);
    const key = target.startsWith('/') ? `xl${target}` : `xl/${target}`;
    const xml = files.get(key)?.toString('utf8') ?? files.get(`xl/${target.replace(/^worksheets\//, 'worksheets/')}`)?.toString('utf8');
    if (!xml) return { name, rows: [] };
    const shared = extractSharedStrings(files.get('xl/sharedStrings.xml')?.toString('utf8') || '');
    return { name, rows: parseSheet(xml, shared) };
  });
  return { sheets };
}

/**
 * 生成最小 .xlsx（**仅供测试夹具与演示数据**）。
 *
 * 能力边界（审查返工 P1-1.4/P1-1.5）：本函数存在的唯一目的是让测试能在临时目录里
 * 造一张表里表，用来验证只读映射逻辑。它不是生产写入能力：运行时服务端
 * （server.mjs 的白名单命令）不暴露任何 Excel 写入/登记命令，
 * 也不得把“测试工具能写临时 xlsx”描述成产品已具备 Excel 登记能力。
 *
 * 实现：把字符串写进 sharedStrings，纯数字识别为数值单元格，其余统一文本。
 * 用 store zip，确保任意环境可生成/读取。
 */
export function writeXlsx(sheets) {
  const wbNames = sheets.map((s, i) => `<sheet name="${escAttr(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('');
  const relTargets = sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('');
  const files = [];
  files.push({ name: '[Content_Types].xml', data: `${ENC}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>` });
  files.push({ name: '_rels/.rels', data: `${ENC}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` });
  files.push({ name: 'xl/workbook.xml', data: `${ENC}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${wbNames}</sheets></workbook>` });
  files.push({ name: 'xl/_rels/workbook.xml.rels', data: `${ENC}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relTargets}</Relationships>` });

  // sharedStrings
  const strIndex = new Map();
  const allText = [];
  for (const sheet of sheets) {
    for (const row of sheet.rows || []) {
      for (const cell of row) {
        const isNumber = typeof cell === 'number' || (typeof cell === 'string' && cell !== '' && /^-?\d+(\.\d+)?$/.test(cell) && !/^0\d/.test(cell));
        if (!isNumber && cell !== '') {
          if (!strIndex.has(cell)) { strIndex.set(cell, allText.length); allText.push(String(cell)); }
        }
      }
    }
  }
  const sharedXml = allText.length
    ? `${ENC}<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${allText.length}" uniqueCount="${allText.length}">${allText.map((t) => `<si><t xml:space="preserve">${esc(t)}</t></si>`).join('')}</sst>`
    : `${ENC}<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="0" uniqueCount="0"/>`;
  files.push({ name: 'xl/sharedStrings.xml', data: sharedXml });

  sheets.forEach((sheet, idx) => {
    const rowXml = (sheet.rows || []).map((row, r) => {
      const cells = row.map((cell, c) => {
        const ref = `${colRef(c)}${r + 1}`;
        if (cell === '' || cell === undefined || cell === null) return '';
        const isNumber = typeof cell === 'number' || (typeof cell === 'string' && /^-?\d+(\.\d+)?$/.test(cell) && !/^0\d/.test(cell));
        if (isNumber) return `<c r="${ref}"><v>${Number(cell)}</v></c>`;
        const sIndex = strIndex.get(String(cell));
        return `<c r="${ref}" t="s"><v>${sIndex}</v></c>`;
      }).join('');
      return cells ? `<row r="${r + 1}">${cells}</row>` : '';
    }).join('');
    files.push({ name: `xl/worksheets/sheet${idx + 1}.xml`, data: `${ENC}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rowXml}</sheetData></worksheet>` });
  });
  return zipStore(files);
}

/**
 * 查找表头所在行（含任一指定关键词的单元格视为表头行），返回 { headerRow, indexOf }。
 */
export function findHeaderRow(rows, keywords) {
  for (let r = 0; r < Math.min(rows.length, 40); r += 1) {
    const row = rows[r] || [];
    for (const cell of row) {
      if (keywords.some((k) => String(cell).includes(k))) return { headerRow: r, row };
    }
  }
  return { headerRow: -1, row: [] };
}
