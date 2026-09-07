import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * 发布包解析 —— 从既有助手的发布包解析逻辑提取只读部分。
 * 原项目未修改；本副本仅保留解析函数，去掉与发布执行相关的回填函数。
 * 不含任何浏览器/交互依赖。
 */

export function stripBom(text) {
  return text.replace(/^﻿/, '');
}

export function parseKeyValueFile(text) {
  const fields = {};
  for (const rawLine of stripBom(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = line.match(/^([^：:]+)[：:]\s*(.*)$/);
    if (match) fields[match[1].trim()] = match[2].trim();
  }
  return fields;
}

export function parseAltFile(text) {
  const records = [];
  for (const rawLine of stripBom(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = line.match(/^(\d+)(?:-[^\\/]+)?\.(?:jpe?g|png|webp)\s*(?:[：:]|[|｜])\s*(?:图片\s*\d+\s*[：:]\s*)?(.*)$/i);
    if (!match) continue;
    records.push({ number: Number(match[1]), name: line.split(/[：:|｜]/, 1)[0].trim(), alt: match[2].trim() });
  }
  return records.sort((a, b) => a.number - b.number);
}

async function readOptionalFile(folder, exactName) {
  try { return await fs.readFile(path.join(folder, exactName), 'utf8'); }
  catch (err) {
    if (err.code === 'ENOENT') return '';
    throw err;
  }
}

export function parsePackageCoreQuestion(text) {
  if (!text) return '';
  const fencedJson = String(text).match(/```json\s*([\s\S]*?)```/i)?.[1];
  if (fencedJson) {
    try { return String(JSON.parse(fencedJson).core_question || '').trim(); }
    catch { /* 继续尝试宽松匹配 */ }
  }
  return String(text).match(/["']core_question["']\s*:\s*["']([^"']+)["']/i)?.[1]?.trim() || '';
}

/** 提取正文 HTML 中所有 <img> 的 src 文件名字段（支持路径/相对路径/纯文件名）。 */
export function extractHtmlImageNames(html) {
  const names = new Set();
  const re = /<img\b[^>]*\bsrc\s*=\s*(["'])([^"']*)\1[^>]*>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const src = m[2];
    if (!src || /^(?:https?:)?\/\//i.test(src) || src.startsWith('data:') || src.startsWith('blob:')) continue;
    names.add(src.split(/[\\/]/).pop());
  }
  return names;
}

/** 有序提取正文 HTML 中 <img> 的 src 文件名（用于乱序/重复检测）。 */
export function extractHtmlImageNamesOrdered(html) {
  const names = [];
  const re = /<img\b[^>]*\bsrc\s*=\s*(["'])([^"']*)\1[^>]*>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const src = m[2];
    if (!src || /^(?:https?:)?\/\//i.test(src) || src.startsWith('data:') || src.startsWith('blob:')) continue;
    let name = src.split(/[\\/]/).pop();
    try { name = decodeURIComponent(name); } catch { /* 保留原值 */ }
    names.push(name);
  }
  return names;
}

function decodeHtmlText(value) {
  return String(value || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 提取每一个正文图片“出现位置”。资产和出现位置分开：同一文件可出现多次，
 * 每次出现都保留自己的 HTML ALT 与显式 figcaption。普通相邻段落不会被猜作图注。
 */
export function extractHtmlImageOccurrences(html) {
  const occurrences = [];
  const re = /<img\b[^>]*>/gi;
  let match;
  while ((match = re.exec(html || '')) !== null) {
    const tag = match[0];
    const attr = (name) => {
      const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, 'i'));
      return m?.[2] || '';
    };
    const src = attr('src');
    let name = src.split(/[\\/]/).pop() || '';
    try { name = decodeURIComponent(name); } catch { /* 保留原值 */ }

    let caption = '';
    const before = html.slice(0, match.index);
    const open = before.lastIndexOf('<figure');
    const close = before.lastIndexOf('</figure>');
    if (open > close) {
      const figureEnd = html.indexOf('</figure>', re.lastIndex);
      if (figureEnd >= 0) {
        const figureHtml = html.slice(open, figureEnd + 9);
        const cap = figureHtml.match(/<figcaption\b[^>]*>([\s\S]*?)<\/figcaption>/i);
        caption = decodeHtmlText(cap?.[1] || '');
      }
    }
    occurrences.push({
      occurrenceId: `img-${occurrences.length + 1}`,
      position: occurrences.length + 1,
      src,
      name,
      htmlAlt: decodeHtmlText(attr('alt')),
      caption,
      captionSource: caption ? '正文 figcaption' : '',
    });
  }
  return occurrences;
}

/**
 * 宽容式发布包检查（阶段1A 只读原型专用）。
 * 与原 loadPackage 不同：不因业务校验失败而抛错，而是把问题收集到 issues 里返回，
 * 以便工作台展示“缺图 / 乱序 / 同名 / 重复图片 / 中文路径”等具体状态。
 * 所有路径都必须已通过 resolveInside 校验。
 */
export async function inspectPackage(absoluteFolder) {
  const folder = path.resolve(absoluteFolder);
  const issues = [];
  const notes = [];

  const entries = await fs.readdir(folder, { withFileTypes: true });
  const files = entries.filter((e) => e.isFile());

  // 文件清单（相对包目录）
  const fileList = [];
  for (const sub of entries.filter((e) => e.isDirectory())) {
    if (/^06-/.test(sub.name)) {
      try {
        for (const f of (await fs.readdir(path.join(folder, sub.name), { withFileTypes: true })).filter((e) => e.isFile())) {
          fileList.push({ relative: `${sub.name}/${f.name}`, bytes: (await fs.stat(path.join(folder, sub.name, f.name))).size });
        }
      } catch { issues.push(`图片目录无法读取：${sub.name}`); }
    }
  }
  for (const f of files) {
    fileList.push({ relative: f.name, bytes: (await fs.stat(path.join(folder, f.name))).size });
  }

  // 1) 新版平台包：01-SEO元数据.json
  let seo = {};
  let alts = [];
  let altSource = '';
  let html = '';
  let title = '';
  const isFile = (n) => files.some((f) => f.name === n);

  if (isFile('01-SEO元数据.json')) {
    try {
      const meta = JSON.parse(await fs.readFile(path.join(folder, '01-SEO元数据.json'), 'utf8'));
      title = meta['锁定标题'] || meta['标题'] || '';
      const keywords = Array.isArray(meta['核心关键词']) ? meta['核心关键词'].join('、') : String(meta['核心关键词'] || '');
      seo = { '内容栏目': meta['产品细分'] || '', '内容标题': title, 'SEO标题': title, 'SEO关键字': keywords, 'SEO描述': meta['SEO描述'] || '' };
      notes.push('新版平台包（01-SEO元数据.json）');
    } catch (err) { issues.push(`SEO 元数据解析失败：${err.message}`); }
    if (isFile('07-图片清单与检查.json')) {
      try {
        const checks = JSON.parse(await fs.readFile(path.join(folder, '07-图片清单与检查.json'), 'utf8'));
        alts = checks.map((x, i) => {
          const declaredName = String(x['文件'] || x.file || x.name || '').trim();
          const declaredNumber = Number.parseInt(declaredName, 10);
          return { number: Number.isFinite(declaredNumber) ? declaredNumber : i + 1, name: declaredName, alt: String(x.ALT || x.alt || '') };
        });
        altSource = '07-图片清单与检查.json';
      } catch (err) { issues.push(`图片清单解析失败：${err.message}`); }
    }
    const htmlEntry = files.find((f) => /^05-发布版-.*\.html$/i.test(f.name));
    if (htmlEntry) html = stripBom(await fs.readFile(path.join(folder, htmlEntry.name), 'utf8'));
  } else if (isFile('01-SEO信息.txt')) {
    // 2) 旧版平台包 / 官网包
    seo = parseKeyValueFile(await fs.readFile(path.join(folder, '01-SEO信息.txt'), 'utf8'));
    seo['SEO关键字'] ||= seo['相关关键词'] || seo['SEO关键词'] || seo['关键词'];
    title = seo['内容标题'] || seo['SEO标题'] || '';
    const htmlEntry = files.find((f) => f.name === '02-后台一键复制正文.html' || /^05-发布版-.*\.html$/i.test(f.name));
    if (htmlEntry) html = stripBom(await fs.readFile(path.join(folder, htmlEntry.name), 'utf8'));
    const altText = await readOptionalFile(folder, '03-图片ALT清单.txt');
    alts = parseAltFile(altText);
    if (alts.length) altSource = '03-图片ALT清单.txt';
    notes.push(isFile('02-后台一键复制正文.html') ? '官网包（02-后台一键复制正文.html）' : '旧版平台包（01-SEO信息.txt）');
  } else {
    const docx = files.find((f) => /\.docx$/i.test(f.name) && !f.name.startsWith('~$'));
    if (docx) notes.push('仅 Word 正文包（阶段1A 不解析 Word 内容，仅登记文件）');
    else issues.push('未识别出发布包标记文件（01-SEO元数据.json / 01-SEO信息.txt / .docx）');
  }

  // 3) 图片：收集 06-* 目录下的编号图片（含子目录，用于同名检测）
  const imageCandidates = [];
  for (const sub of entries.filter((e) => e.isDirectory() && /^06-/.test(e.name))) {
    for (const f of (await fs.readdir(path.join(folder, sub.name), { withFileTypes: true })).filter((e) => e.isFile())) {
      if (/^\d+(?:[-_][^\\/]+)?\.(?:jpe?g|png|webp)$/i.test(f.name)) {
        imageCandidates.push({ dir: sub.name, name: f.name, number: Number.parseInt(f.name, 10) });
      }
    }
  }
  imageCandidates.sort((a, b) => a.number - b.number || a.name.localeCompare(b.name));

  // 同名文件检测：不同子目录存在同名图片 → 无法按文件名唯一绑定
  const byName = new Map();
  for (const c of imageCandidates) {
    const key = c.name.toLowerCase();
    byName.set(key, (byName.get(key) || 0) + 1);
  }
  for (const [key, count] of byName) {
    if (count > 1) issues.push(`同名图片文件出现在多个图片目录，无法按文件名唯一绑定：${key}（${count} 处）`);
  }

  // 4) HTML 占位与图片的对照
  const htmlNames = extractHtmlImageNamesOrdered(html);
  const htmlNameSet = new Set(htmlNames.map((n) => n.toLowerCase()));
  for (const n of htmlNames) {
    if (!imageCandidates.some((c) => c.name.toLowerCase() === n.toLowerCase())) {
      issues.push(`正文引用的图片在包内未找到（缺图）：${n}`);
    }
  }
  for (const c of imageCandidates) {
    if (html && !htmlNameSet.has(c.name.toLowerCase())) {
      issues.push(`图片未在正文中引用：${c.dir}/${c.name}`);
    }
  }

  // 乱序检测：HTML 占位顺序与图片编号顺序不一致（仅提示，ALT 按内容/编号绑定，不按位置）
  if (htmlNames.length >= 2) {
    const orderNumbers = htmlNames.map((n) => imageCandidates.find((c) => c.name.toLowerCase() === n.toLowerCase())?.number).filter((n) => n !== undefined);
    const sorted = [...orderNumbers].sort((a, b) => a - b);
    if (orderNumbers.join(',') !== sorted.join(',')) {
      notes.push(`正文图片出现顺序与编号顺序不一致（乱序）：HTML 顺序 [${orderNumbers.join(' → ')}]，编号顺序 [${sorted.join(' → ')}]；ALT 按图片编号绑定，不按出现位置`);
    }
  }

  // 5) ALT 数量与编号
  if (alts.length && imageCandidates.length && alts.length !== imageCandidates.length) {
    issues.push(`图片与 ALT 数量不一致：图片 ${imageCandidates.length} 张，ALT ${alts.length} 条`);
  }
  const altNumbers = alts.map((a) => a.number);
  for (let i = 0; i < altNumbers.length; i += 1) {
    if (altNumbers[i] !== i + 1) { issues.push(`ALT 编号不连续：期望 ${i + 1}，实际 ${altNumbers[i]}`); break; }
  }
  const emptyAlt = alts.filter((a) => !a.alt).length;
  if (emptyAlt) issues.push(`有 ${emptyAlt} 条 ALT 为空`);

  // 6) 完整映射链：正文出现位置 → 唯一文件资产 → 清单 ALT / HTML ALT → 显式图注
  const occurrences = extractHtmlImageOccurrences(html).map((occ) => {
    const assets = imageCandidates.filter((c) => c.name.toLowerCase() === occ.name.toLowerCase());
    const asset = assets.length === 1 ? assets[0] : null;
    const manifest = asset ? alts.find((a) => a.number === asset.number) : null;
    const manifestAlt = manifest?.alt || '';
    const altConflict = Boolean(manifestAlt && occ.htmlAlt && manifestAlt !== occ.htmlAlt);
    if (altConflict) issues.push(`ALT 冲突：正文第 ${occ.position} 张（${occ.name}）清单为“${manifestAlt}”，HTML 为“${occ.htmlAlt}”`);
    return {
      ...occ,
      assetNumber: asset?.number || null,
      assetName: asset?.name || '',
      assetDir: asset?.dir || '',
      assetMatch: assets.length === 1 ? '正文文件名唯一匹配' : assets.length > 1 ? '同名冲突' : '未找到文件',
      manifestAlt,
      effectiveAlt: manifestAlt || occ.htmlAlt,
      altSource: manifestAlt ? altSource : (occ.htmlAlt ? '正文 img alt' : ''),
      altConflict,
    };
  });

  return {
    folder,
    seo,
    title,
    html,
    alts,
    altSource,
    images: imageCandidates.map((c) => ({ dir: c.dir, name: c.name, number: c.number })),
    occurrences,
    fileList,
    issues,
    notes,
    coreQuestion: parsePackageCoreQuestion(await readOptionalFile(folder, '04-文章任务单与发布验收.md')),
  };
}

export const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 24 * 1024 * 1024;

/** 读取图片为 data URL（带 SHA-256 内容指纹，用于重复图片检测）。 */
export async function readImageAsDataUrl(imagePath) {
  const { createHash } = await import('node:crypto');
  const buf = await fs.readFile(imagePath);
  if (buf.length > MAX_IMAGE_BYTES) throw new Error(`图片超过15MB：${path.basename(imagePath)}`);
  const ext = path.extname(imagePath).slice(1).toLowerCase();
  const mime = ext === 'jpg' ? 'jpeg' : ext;
  return {
    dataUrl: `data:image/${mime};base64,${buf.toString('base64')}`,
    sha256: createHash('sha256').update(buf).digest('hex'),
    bytes: buf.length,
  };
}

/** 只读图片字节数与 SHA-256（发送快照用，不构造 data URL，避免大图进内存多一次）。 */
export async function hashImageFile(imagePath) {
  const { createHash } = await import('node:crypto');
  const buf = await fs.readFile(imagePath);
  if (buf.length > MAX_IMAGE_BYTES) throw new Error(`图片超过15MB：${path.basename(imagePath)}`);
  return { sha256: createHash('sha256').update(buf).digest('hex'), bytes: buf.length };
}
