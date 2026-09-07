import fs from 'node:fs/promises';
import path from 'node:path';
import { inspectPackage } from './package.mjs';
import { resolveInside } from './security.mjs';

/**
 * 只读扫描器（阶段1A）。
 * 沿用原助手 scanner.mjs 的发布包识别标记（01-SEO元数据.json / 01-SEO信息.txt /
 * 02-后台一键复制正文.html / 非 ~$ 的 .docx），但不依赖 sites.json，
 * 平台/产品线/日期由相对路径分段推断，识别结果原样展示，不改名不搬迁。
 */

const SKIP_DIR = (name) => name.startsWith('.') || name === 'node_modules' || name.startsWith('~$');

function isPackageDir(fileNames) {
  return fileNames.includes('01-SEO元数据.json')
    || fileNames.includes('01-SEO信息.txt')
    || fileNames.includes('02-后台一键复制正文.html')
    || fileNames.some((n) => /\.docx$/i.test(n) && !n.startsWith('~$'));
}

async function listDirSafe(dir) {
  try {
    return (await fs.readdir(dir, { withFileTypes: true }));
  } catch {
    return [];
  }
}

/** 单个图片 / ALT / 缺失统计（卡片摘要用，不读图片内容）。 */
async function summarizePackage(absolutePath) {
  const info = await inspectPackage(absolutePath);
  return {
    title: info.title || path.basename(absolutePath),
    imageCount: info.images.length,
    altCount: info.alts.length,
    issueCount: info.issues.length,
    issues: info.issues.slice(0, 8),
    notes: info.notes,
  };
}

/**
 * 扫描授权根目录下的所有发布包。
 * 返回 [{packageId, relativePath, segments, ...summary}]。
 * packageId 为服务端签发的受控 ID（sha256 摘要），接口不返回也不接受绝对路径。
 */
export async function scanRoot(rootDir, rootName, makePackageId) {
  const { resolvedRoot } = await resolveInside(rootDir, '.');
  const results = [];

  async function walk(dir, segments) {
    const entries = await listDirSafe(dir);
    const fileNames = entries.filter((e) => e.isFile()).map((e) => e.name);
    if (isPackageDir(fileNames)) {
      const relativePath = path.relative(resolvedRoot, dir).split(path.sep).join('/');
      try {
        const summary = await summarizePackage(dir);
        results.push({ packageId: makePackageId(rootName, relativePath), relativePath, segments, ...summary });
      } catch (err) {
        results.push({
          packageId: makePackageId(rootName, relativePath), relativePath, segments,
          title: path.basename(dir), imageCount: 0, altCount: 0, issueCount: 1,
          issues: [`发布包读取失败：${err.message}`], notes: [],
        });
      }
      return; // 识别为发布包后不再深入
    }
    // 不深入符号链接/junction 目录，防止授权目录外的内容被扫描进来（见 security.mjs）
    const subDirs = [];
    let skippedLinks = 0;
    for (const entry of entries) {
      if (SKIP_DIR(entry.name)) continue;
      // junction / symlink：readdir 的 dirent 标记为 isSymbolicLink（Windows junction 同样如此）
      if (entry.isSymbolicLink()) { skippedLinks += 1; continue; }
      if (!entry.isDirectory()) continue;
      subDirs.push(entry.name);
    }
    if (skippedLinks) results.push({ packageId: null, relativePath: path.relative(resolvedRoot, dir).split(path.sep).join('/'), segments, skippedLinks, title: `（已跳过 ${skippedLinks} 个符号链接/junction 子目录）`, imageCount: 0, altCount: 0, issueCount: 0, issues: [], notes: [] });
    for (const name of subDirs) {
      await walk(path.join(dir, name), [...segments, name]);
    }
  }

  await walk(resolvedRoot, []);
  return results;
}
