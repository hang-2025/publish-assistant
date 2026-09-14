import fs from 'node:fs/promises';
import path from 'node:path';
import { assertRootsIndependent, resolveInside, validateRootDir } from './security.mjs';

function isInside(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function assertTreeContainsNoLinks(dir) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const child = path.join(dir, entry.name);
    const stat = await fs.lstat(child);
    if (stat.isSymbolicLink()) throw new Error(`文章包内含符号链接或 junction，已拒绝移动：${entry.name}`);
    if (stat.isDirectory()) await assertTreeContainsNoLinks(child);
  }
}

async function ensureSafeParent(root, relativeSegments) {
  let current = root;
  for (const segment of relativeSegments) {
    current = path.join(current, segment);
    if (!isInside(current, root)) throw new Error('归档目标路径越界，已拒绝移动');
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) throw new Error('归档目标路径包含符号链接或 junction，已拒绝移动');
      if (!stat.isDirectory()) throw new Error('归档目标的上级路径不是目录，已拒绝移动');
      const resolved = await fs.realpath(current);
      if (!isInside(resolved, root)) throw new Error('归档目标路径越界，已拒绝移动');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      await fs.mkdir(current);
    }
  }
  return current;
}

/**
 * 将一个已扫描的文章包原子移动到已归档根目录。
 * 只接受服务端索引中的相对路径；不覆盖同名目标，也不复制后删除。
 */
export async function movePackageToArchive({ sourceRoot, archiveRoot, relativePath }) {
  const resolvedSourceRoot = await validateRootDir(sourceRoot);
  const resolvedArchiveRoot = await validateRootDir(archiveRoot);
  assertRootsIndependent(resolvedSourceRoot, resolvedArchiveRoot);
  const { absolutePath: sourceDir } = await resolveInside(resolvedSourceRoot, relativePath);
  const sourceStat = await fs.lstat(sourceDir);
  if (sourceStat.isSymbolicLink() || !sourceStat.isDirectory()) throw new Error('文章包不是可移动的普通目录');
  await assertTreeContainsNoLinks(sourceDir);

  const segments = String(relativePath || '').split(/[\\/]+/).filter(Boolean);
  if (!segments.length || segments.some((segment) => segment === '.' || segment === '..')) {
    throw new Error('文章包相对路径无效');
  }
  const leaf = segments.at(-1);
  const targetParent = await ensureSafeParent(resolvedArchiveRoot, segments.slice(0, -1));
  const targetDir = path.join(targetParent, leaf);
  if (!isInside(targetDir, resolvedArchiveRoot)) throw new Error('归档目标路径越界，已拒绝移动');
  try {
    await fs.lstat(targetDir);
    throw new Error('已归档目录中存在同名文章包，未覆盖、未移动');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  try {
    await fs.rename(sourceDir, targetDir);
  } catch (error) {
    if (error?.code === 'EXDEV') throw new Error('未归档与已归档目录不在同一磁盘，无法安全原子移动');
    throw error;
  }
  const targetStat = await fs.stat(targetDir);
  if (!targetStat.isDirectory()) throw new Error('移动完成后的目标不是目录，请人工检查');
  try {
    await fs.lstat(sourceDir);
    throw new Error('移动后源目录仍然存在，请人工检查');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return { ok: true, relativePath, moved: true };
}
