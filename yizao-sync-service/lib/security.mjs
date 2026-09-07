import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * 路径安全模块（阶段1A 只读原型）
 *
 * 设计要点（对应审查要求三.3）：
 * - 所有对授权目录内文件的访问必须经过 resolveInside()；
 * - 使用 fs.realpath 解析 Windows junction / 符号链接 / 大小写差异后的真实路径；
 * - 只有真实路径仍位于已 realpath 的授权根目录之内才放行；
 * - 接口层只接受扫描时签发的受控包 ID，不接受任意文件路径（见 server.mjs）。
 */

/** realpath 封装：目录不存在时抛出带 code 的错误，不静默返回原路径。 */
async function real(p) {
  try {
    return await fs.realpath(path.resolve(p));
  } catch (err) {
    err.message = `路径不可访问（含符号链接断裂可能）：${p}`;
    throw err;
  }
}

function insideResolved(resolvedTarget, resolvedRoot) {
  const a = resolvedTarget.toLowerCase();
  const b = resolvedRoot.toLowerCase();
  return a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
}

/**
 * 校验 relativePath 位于 rootDir 之内，返回真实绝对路径。
 * 任何 .. 、绝对路径、junction 指向外部的情况都会抛错。
 */
export async function resolveInside(rootDir, relativePath) {
  if (!relativePath || typeof relativePath !== 'string') throw new Error('缺少相对路径');
  if (path.isAbsolute(relativePath)) throw new Error('不接受绝对路径');
  if (/(^|[\\/])\.\.([\\/]|$)/.test(relativePath)) throw new Error('不接受包含 .. 的路径');
  const resolvedRoot = await real(rootDir);
  const candidate = path.resolve(resolvedRoot, relativePath);
  const resolvedTarget = await real(candidate);
  if (!insideResolved(resolvedTarget, resolvedRoot)) {
    throw new Error('路径越界：目标不在授权目录内（已解析符号链接/junction）');
  }
  return { absolutePath: resolvedTarget, resolvedRoot };
}

/** 校验一个候选授权根目录：必须已存在、是目录，返回 realpath。不创建目录。 */
export async function validateRootDir(dir) {
  const resolved = await real(dir);
  const stat = await fs.stat(resolved);
  if (!stat.isDirectory()) throw new Error(`不是目录：${dir}`);
  return resolved;
}

/** 两个根目录不允许相同或互相嵌套（避免未发布/已发布循环）。 */
export function assertRootsIndependent(a, b) {
  if (!a || !b) return;
  const lower = (p) => path.resolve(p).toLowerCase();
  const [x, y] = [lower(a), lower(b)];
  if (x === y) throw new Error('未发布目录与已发布目录不能相同');
  if (x.startsWith(y + path.sep) || y.startsWith(x + path.sep)) {
    throw new Error('未发布目录与已发布目录不能互相嵌套');
  }
}

/** 多个已配置根目录两两不允许相同或互相嵌套。 */
export function assertRootSetIndependent(roots) {
  const entries = Object.entries(roots || {}).filter(([, value]) => value);
  const label = {
    unpublished: '未发布目录',
    published: '已发布目录',
    archive: '归档目标目录',
  };
  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      const [ka, a] = entries[i];
      const [kb, b] = entries[j];
      const lower = (p) => path.resolve(p).toLowerCase();
      const [x, y] = [lower(a), lower(b)];
      if (x === y) throw new Error(`${label[ka] || ka}与${label[kb] || kb}不能相同`);
      if (x.startsWith(y + path.sep) || y.startsWith(x + path.sep)) {
        throw new Error(`${label[ka] || ka}与${label[kb] || kb}不能互相嵌套`);
      }
    }
  }
}

/** 判断两个路径（已 realpath）是否指向同一内容（大小写不敏感比较）。 */
export function samePath(a, b) {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}
