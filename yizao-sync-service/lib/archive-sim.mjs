import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { writeJsonAtomic } from './tasks.mjs';

/**
 * 归档恢复设计 + 纯模拟（阶段1B，2026-09-04 审查返工重写）。
 *
 * 约束（对应任务书 P1 + 审查 P0-3）：
 * - 不复制、不启用旧 archive.mjs 的删除/移动逻辑；本模块只做“复制 + 校验”，
 *   并且只能在调用方显式传入的临时目录夹具上运行（服务端不暴露任何归档命令，
 *   因此绝不会触及用户真实目录）；
 * - 本模块不暴露 HTTP 命令、不删除源、不删除目标；
 * - 任一步失败都保留源目录与已完成的目标副本；异常分支绝不删除目标副本；
 * - 复制全程逐文件 SHA-256 校验；过程写入操作日志与可恢复检查点；
 * - 提供“多平台共享包归档门槛”：只要任一平台的正式发布/草稿目标未满足，
 *   就不允许把整个包移走/归档，避免一个平台完成后让其他平台失去源文件。
 *
 * 审查返工 P0-3 修正的四类“错误成功 / 无法续传”：
 * 1. 命中 `.done.json` 一律重新核验目标文件清单、大小与 SHA-256；
 *    缺失、被篡改、出现计划外文件都不得报成功（旧实现直接返回成功）。
 * 2. 检查点带 operationId + planSummary（源/目标真实路径 + 文件清单摘要），
 *    恢复前必须核验 source、target 与当前计划一致；不一致立即停止并报告，不猜测恢复。
 * 3. 支持“复制已完成但检查点尚未写入”的安全恢复：目标文件已存在且哈希一致 →
 *    记为已完成并补写完成标记；哈希不同 → 立即停止，绝不覆盖。
 * 4. source / target / checkpoint 三个根目录都做真实路径边界校验
 *    （realpath + 逐段拒绝符号链接/junction），source 与 target 不得相同或互相嵌套，
 *    checkpoint 不得落在 source 或 target 之内（否则会被当成内容复制/被覆盖）。
 */

export const CHECKPOINT_SCHEMA = 2;

export function fileSha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** 读取目录内全部文件（相对路径 → 内容），用于夹具准备与断言。 */
export async function collectFiles(root) {
  const out = new Map();
  async function walk(dir, rel) {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const p = path.join(dir, e.name);
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(p, relPath);
      else if (e.isFile()) out.set(relPath, await fs.readFile(p));
    }
  }
  await walk(root, '');
  return out;
}

/** 计算一个文件的 sha256（用于计划与完成校验，避免把整棵树塞进一个内存 map）。 */
async function hashFile(file) {
  const h = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = fss.createReadStream(file);
    stream.on('data', (d) => h.update(d));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return h.digest('hex');
}

function lowerResolved(p) { return path.resolve(p).toLowerCase(); }

/** child 是否位于 parent 之内（不含相等）。 */
export function isStrictlyInside(child, parent) {
  const c = lowerResolved(child);
  const p = lowerResolved(parent);
  return c !== p && c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

/**
 * 解析目录真实路径：从盘符根开始逐段下行，已存在的段一律 realpath，
 * 且任何已存在的段若是符号链接/junction 直接拒绝——否则写入会被重定向到目录之外。
 * 尚不存在的段按字面拼接（由我们随后创建），不做猜测。
 */
async function resolveStrictDir(dir, label) {
  if (!dir || typeof dir !== 'string' || !dir.trim()) throw new Error(`${label} 不能为空`);
  const full = path.resolve(dir);
  const root = path.parse(full).root;
  let real = await fs.realpath(root);
  for (const seg of path.relative(root, full).split(path.sep).filter(Boolean)) {
    const next = path.join(real, seg);
    let st = null;
    try { st = await fs.lstat(next); } catch { st = null; }
    if (!st) { real = next; continue; }
    if (st.isSymbolicLink()) throw new Error(`${label}路径包含符号链接/junction（${next}），拒绝执行归档`);
    if (!st.isDirectory()) throw new Error(`${label}不是目录：${next}`);
    real = await fs.realpath(next);
  }
  return real;
}

/**
 * 三个根目录的边界校验：真实路径 + 互不嵌套 + checkpoint 不落在 source/target 内。
 * @returns {{source:string, target:string, checkpoint:string}}
 */
export async function resolveArchivePaths({ sourceDir, targetDir, checkpointDir }) {
  const source = await resolveStrictDir(sourceDir, '归档源');
  const target = await resolveStrictDir(targetDir, '归档目标');
  const checkpoint = await resolveStrictDir(checkpointDir, '检查点');
  if (lowerResolved(source) === lowerResolved(target)) throw new Error('归档源与目标不能相同');
  if (isStrictlyInside(target, source)) throw new Error('归档目标不能位于源目录之内（会递归复制自身）');
  if (isStrictlyInside(source, target)) throw new Error('归档源不能位于目标目录之内');
  if (lowerResolved(checkpoint) === lowerResolved(source) || isStrictlyInside(checkpoint, source)) {
    throw new Error('检查点目录不能位于归档源之内（会被当成内容一起复制）');
  }
  if (lowerResolved(checkpoint) === lowerResolved(target) || isStrictlyInside(checkpoint, target)) {
    throw new Error('检查点目录不能位于归档目标之内（会在校验清单时被当成脏数据）');
  }
  return { source, target, checkpoint };
}

/** 文件清单摘要：与顺序无关地覆盖 相对路径+哈希+大小。 */
function digestFiles(files) {
  const h = crypto.createHash('sha256');
  for (const f of [...files].sort((a, b) => (a.relative < b.relative ? -1 : 1))) {
    h.update(`${f.relative}\0${f.sha256}\0${f.bytes}\n`);
  }
  return h.digest('hex');
}

/** 稳定操作 ID / 计划摘要：源真实路径 + 目标真实路径 + 文件清单摘要。 */
export function makeOperationId({ source, target, files }) {
  const filesDigest = digestFiles(files);
  const planSummary = crypto.createHash('sha256')
    .update(`${source}\n${target}\n${filesDigest}\n`)
    .digest('hex');
  return { filesDigest, planSummary, operationId: `op-${planSummary.slice(0, 24)}` };
}

/**
 * 构造归档执行计划（复制到 targetDir，不移动、不删除源）。
 * 源目录内的符号链接/junction 一律拒绝（不跟随、不复制）。
 * @returns 计划对象（含 operationId / planSummary / files / totalBytes）
 */
export async function buildCopyPlan({ sourceDir, targetDir, checkpointDir }) {
  const paths = await resolveArchivePaths({ sourceDir, targetDir, checkpointDir });
  const files = [];
  async function walk(dir, rel) {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const p = path.join(dir, e.name);
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) throw new Error(`归档源包含符号链接/junction（${relPath}），拒绝执行归档`);
      if (e.isDirectory()) await walk(p, relPath);
      else if (e.isFile()) {
        const st = await fs.stat(p);
        files.push({ relative: relPath, sha256: await hashFile(p), bytes: st.size });
      }
    }
  }
  await walk(paths.source, '');
  files.sort((a, b) => (a.relative < b.relative ? -1 : 1));
  const plan = {
    schema: CHECKPOINT_SCHEMA,
    createdAt: new Date().toISOString(),
    source: paths.source,
    target: paths.target,
    checkpoint: paths.checkpoint,
    files,
    fileCount: files.length,
    totalBytes: files.reduce((s, f) => s + f.bytes, 0),
  };
  const { filesDigest, planSummary, operationId } = makeOperationId(plan);
  plan.filesDigest = filesDigest;
  plan.planSummary = planSummary;
  plan.operationId = operationId;
  return plan;
}

function checkpointPaths(plan) {
  return {
    progress: path.join(plan.checkpoint, `${plan.operationId}.progress.json`),
    done: path.join(plan.checkpoint, `${plan.operationId}.done.json`),
    log: path.join(plan.checkpoint, `${plan.operationId}.log.jsonl`),
  };
}

async function readJson(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return null; }
}

/** 追加一行操作日志（纯审计，失败不影响主流程判定）。 */
async function appendLog(logPath, event) {
  try {
    await fs.appendFile(logPath, `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...event })}\n`, 'utf8');
  } catch { /* 日志不可写不阻断归档判定 */ }
}

/** 检查点/完成标记是否属于“当前这一次操作”：schema、operationId、planSummary、source、target 全都要对。 */
export function checkpointMismatch(marker, plan, label) {
  if (!marker || typeof marker !== 'object') return `${label}无法解析，已停止（未覆盖任何文件）`;
  if (marker.schema !== CHECKPOINT_SCHEMA) return `${label}版本不一致（schema=${marker.schema}，期望 ${CHECKPOINT_SCHEMA}），已停止（未覆盖任何文件）`;
  if (marker.operationId !== plan.operationId || marker.planSummary !== plan.planSummary) {
    return `${label}属于另一次归档操作（${marker.operationId || '未知'} ≠ ${plan.operationId}）：源/目标或文件清单不一致，已停止（未覆盖任何文件）`;
  }
  if (lowerResolved(marker.source || '') !== lowerResolved(plan.source)) {
    return `${label}的源目录与当前源不一致，已停止（未覆盖任何文件）`;
  }
  if (lowerResolved(marker.target || '') !== lowerResolved(plan.target)) {
    return `${label}的目标目录与当前目标不一致，已停止（未覆盖任何文件）`;
  }
  return '';
}

/**
 * 目标目录现状与计划的逐项比对：区分“完全一致 / 内容不同 / 计划外文件 / 链接”。
 * @returns {{exists:boolean, matching:string[], mismatch:string[], extra:string[], links:string[]}}
 */
export async function inspectTargetAgainstPlan(plan) {
  const out = { exists: false, matching: [], mismatch: [], extra: [], links: [] };
  try {
    const st = await fs.lstat(plan.target);
    out.exists = st.isDirectory();
  } catch { return out; }
  if (!out.exists) return out;
  const planMap = new Map(plan.files.map((f) => [f.relative, f]));
  async function walk(dir, rel) {
    const list = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of list) {
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      const p = path.join(dir, e.name);
      if (e.isSymbolicLink()) { out.links.push(relPath); continue; }
      if (e.isDirectory()) { await walk(p, relPath); continue; }
      if (!e.isFile()) continue;
      const expected = planMap.get(relPath);
      if (!expected) { out.extra.push(relPath); continue; }
      const st = await fs.stat(p).catch(() => null);
      if (!st || st.size !== expected.bytes) { out.mismatch.push(relPath); continue; }
      if ((await hashFile(p)) !== expected.sha256) { out.mismatch.push(relPath); continue; }
      out.matching.push(relPath);
    }
  }
  await walk(plan.target, '');
  return out;
}

/** 完成校验：目标文件清单必须与计划完全相同（不缺、不多、哈希一致）。 */
export async function verifyTargetMatchesPlan(plan) {
  const state = await inspectTargetAgainstPlan(plan);
  if (state.links.length) return { ok: false, reason: `目标目录包含符号链接/junction（${state.links.slice(0, 3).join(', ')}）` };
  if (state.extra.length) return { ok: false, reason: `目标目录存在计划外的文件（${state.extra.slice(0, 3).join(', ')}）` };
  if (state.mismatch.length) return { ok: false, reason: `目标文件被篡改或大小不一致（${state.mismatch.slice(0, 3).join(', ')}）` };
  if (state.matching.length !== plan.files.length) {
    const missing = plan.files.map((f) => f.relative).filter((r) => !state.matching.includes(r));
    return { ok: false, reason: `目标缺少 ${plan.files.length - state.matching.length} 个文件（${missing.slice(0, 3).join(', ')}）` };
  }
  return { ok: true, reason: '', fileCount: state.matching.length };
}

/**
 * 执行纯复制归档（带检查点）。不删除任何源文件；异常时不删除已完成的目标副本。
 *
 * @param {object} args
 * @param {string} args.sourceDir
 * @param {string} args.targetDir
 * @param {string} args.checkpointDir
 * @param {boolean} [args.allowResume=true] 命中已有未完成检查点时允许续传
 * @param {(rel:string)=>Promise<void>|void} [args.onCopied] 每完成一个文件回调（测试注入中断点）
 * @returns {Promise<{ok:boolean, copied:string[], resumed:boolean, targetDir?:string,
 *   alreadyComplete?:boolean, verified?:boolean, recoveredUncheckpointed?:boolean,
 *   recoveredPartial?:boolean, needsManual?:boolean, reason?:string,
 *   checkpoint?:string, operationId?:string}>}
 */
export async function copyArchiveWithCheckpoints({ sourceDir, targetDir, checkpointDir, allowResume = true, onCopied }) {
  let plan;
  try {
    plan = await buildCopyPlan({ sourceDir, targetDir, checkpointDir });
  } catch (err) {
    return { ok: false, copied: [], resumed: false, reason: err.message, needsManual: true };
  }
  if (plan.files.length === 0) {
    return { ok: false, copied: [], resumed: false, reason: '没有可复制文件' };
  }
  const paths = checkpointPaths(plan);
  await fs.mkdir(plan.checkpoint, { recursive: true });
  await appendLog(paths.log, { event: 'plan', operationId: plan.operationId, fileCount: plan.files.length, totalBytes: plan.totalBytes });

  // ① 完成标记：绝不盲信，必须重新核验目标清单 + 大小 + SHA-256。
  const doneMarker = await readJson(paths.done);
  if (doneMarker) {
    const mismatch = checkpointMismatch(doneMarker, plan, '完成标记');
    if (mismatch) {
      await appendLog(paths.log, { event: 'done-marker-mismatch', operationId: plan.operationId });
      return { ok: false, copied: [], resumed: false, reason: mismatch, needsManual: true, operationId: plan.operationId };
    }
    const verify = await verifyTargetMatchesPlan(plan);
    if (!verify.ok) {
      await appendLog(paths.log, { event: 'done-verify-failed', operationId: plan.operationId, reason: verify.reason });
      return { ok: false, copied: [], resumed: false, alreadyComplete: false, reason: `完成标记存在但目标校验失败：${verify.reason}。已停止，未覆盖、未删除任何文件，请人工核对。`, needsManual: true, operationId: plan.operationId };
    }
    await appendLog(paths.log, { event: 'done-verified', operationId: plan.operationId, fileCount: verify.fileCount });
    return {
      ok: true, copied: [], resumed: false, alreadyComplete: true, verified: true,
      targetDir: plan.target, fileCount: verify.fileCount, operationId: plan.operationId,
    };
  }

  // ② 进度检查点：必须属于本次操作（源/目标/文件清单一致）才允许续传。
  let resumedList = [];
  const raw = await readJson(paths.progress);
  if (raw) {
    const mismatch = checkpointMismatch(raw, plan, '检查点');
    if (mismatch) {
      await appendLog(paths.log, { event: 'progress-mismatch', operationId: plan.operationId });
      return { ok: false, copied: [], resumed: false, reason: mismatch, needsManual: true, operationId: plan.operationId };
    }
    resumedList = Array.isArray(raw.copied) ? raw.copied.filter((r) => plan.files.some((f) => f.relative === r)) : [];
  }
  const resumed = allowResume && resumedList.length > 0;

  // ③ 目标目录现状：先区分“计划外文件 / 内容不同 / 已复制过”。
  const state = await inspectTargetAgainstPlan(plan);
  if (state.links.length) {
    return { ok: false, copied: [], resumed: false, reason: `目标目录包含符号链接/junction（${state.links.slice(0, 3).join(', ')}），拒绝继续`, needsManual: true, operationId: plan.operationId };
  }
  if (state.extra.length) {
    return { ok: false, copied: [], resumed: false, reason: `目标目录已存在且包含计划外文件（${state.extra.slice(0, 3).join(', ')}），拒绝覆盖`, needsManual: true, operationId: plan.operationId };
  }
  if (state.mismatch.length) {
    return { ok: false, copied: [], resumed: false, reason: `目标已存在同名文件但内容/大小不一致（${state.mismatch.slice(0, 3).join(', ')}），拒绝覆盖，绝不猜测`, needsManual: true, operationId: plan.operationId };
  }

  const doneSet = new Set(state.matching);
  if (resumed) for (const rel of resumedList) doneSet.add(rel);

  // 复制已完成、但检查点/完成标记尚未写入 → 核验哈希后补写完成标记，绝不重复复制、绝不覆盖。
  if (!resumed && state.matching.length === plan.files.length) {
    await writeJsonAtomic(paths.done, {
      schema: CHECKPOINT_SCHEMA, operationId: plan.operationId, planSummary: plan.planSummary,
      source: plan.source, target: plan.target, finishedAt: new Date().toISOString(),
      files: plan.files.length, fileCount: plan.files.length, totalBytes: plan.totalBytes,
    });
    await fs.rm(paths.progress, { force: true });
    await appendLog(paths.log, { event: 'recovered-uncheckpointed-copy', operationId: plan.operationId, fileCount: plan.files.length });
    return {
      ok: true, copied: [], resumed: false, alreadyComplete: true, verified: true,
      recoveredUncheckpointed: true, targetDir: plan.target, fileCount: plan.files.length, operationId: plan.operationId,
    };
  }
  // 部分文件已复制但没有检查点（首次复制后、写检查点前中断）→ 记为已完成并继续剩下的。
  const recoveredPartial = !resumed && state.matching.length > 0;

  const needed = plan.files.filter((f) => !doneSet.has(f.relative));
  const copiedList = [...doneSet];
  await fs.mkdir(plan.target, { recursive: true });
  const writeProgress = async () => {
    await writeJsonAtomic(paths.progress, {
      schema: CHECKPOINT_SCHEMA, operationId: plan.operationId, planSummary: plan.planSummary,
      source: plan.source, target: plan.target, createdAt: plan.createdAt,
      updatedAt: new Date().toISOString(),
      plan: { files: plan.files, fileCount: plan.files.length, totalBytes: plan.totalBytes },
      copied: copiedList,
    });
  };

  try {
    for (const f of needed) {
      const src = path.join(plan.source, f.relative);
      const dst = path.join(plan.target, f.relative);
      // 计划来自受控遍历，这里再做一次边界兜底：任何越界立即停止，不写任何文件。
      const srcResolved = path.resolve(src);
      if (!isStrictlyInside(srcResolved, plan.source)) throw new Error(`归档源路径越界：${f.relative}`);
      const dstResolved = path.resolve(dst);
      if (!isStrictlyInside(dstResolved, plan.target)) throw new Error(`归档目标路径越界：${f.relative}`);
      await fs.mkdir(path.dirname(dst), { recursive: true });
      // 源文件在计划生成后被改动 → 立即停止（保留源与已完成副本）。
      const srcHash = await hashFile(src);
      if (srcHash !== f.sha256) throw new Error(`源文件哈希不一致，已中止并保留源与已完成副本：${f.relative}`);
      // 目标已存在：哈希一致视为已完成，哈希不同立即停止——绝不覆盖。
      if (fss.existsSync(dst)) {
        const dstHash = await hashFile(dst);
        if (dstHash !== f.sha256) throw new Error(`目标已存在同名文件且内容不同，拒绝覆盖并停止：${f.relative}`);
      } else {
        await fs.copyFile(src, dst);
        const dstHash = await hashFile(dst);
        if (dstHash !== f.sha256) throw new Error(`目标写入后哈希校验失败，已停止：${f.relative}`);
      }
      if (onCopied) await onCopied(f.relative);
      copiedList.push(f.relative);
      await writeProgress(); // 恢复检查点（原子）
      await appendLog(paths.log, { event: 'copied', rel: f.relative, bytes: f.bytes });
    }
    // ④ 完成校验：目标清单必须与计划完全一致，才写完成标记。
    const verify = await verifyTargetMatchesPlan(plan);
    if (!verify.ok) throw new Error(`完成校验失败：${verify.reason}`);
    await writeJsonAtomic(paths.done, {
      schema: CHECKPOINT_SCHEMA, operationId: plan.operationId, planSummary: plan.planSummary,
      source: plan.source, target: plan.target, finishedAt: new Date().toISOString(),
      files: plan.files.length, fileCount: plan.files.length, totalBytes: plan.totalBytes,
    });
    await fs.rm(paths.progress, { force: true });
    await appendLog(paths.log, { event: 'done', operationId: plan.operationId, fileCount: plan.files.length });
    return {
      ok: true, copied: copiedList, resumed, targetDir: plan.target,
      recoveredPartial, operationId: plan.operationId, fileCount: plan.files.length,
    };
  } catch (err) {
    // 关键：异常分支不删除源、不删除已完成目标副本，只保留检查点便于续传。
    await appendLog(paths.log, { event: 'failed', operationId: plan.operationId, reason: err.message, copied: copiedList.length });
    return {
      ok: false, copied: copiedList, resumed, reason: err.message,
      checkpoint: paths.progress, operationId: plan.operationId,
    };
  }
}

/**
 * 多平台共享包归档门槛：只要任一要求的平台任务不满足，就不得移动/归档整个包。
 * @param {object} args
 * @param {string} args.packageId
 * @param {Array<{platform:string, platformName?:string, draftStage?:string, publishStatus?:string}>} args.requiredPlatforms
 *   要求完成归档的平台及其任务状态。
 * @returns {{ ready:boolean, reasons:string[] }}
 */
export function archiveGateForSharedPackage({ packageId, requiredPlatforms }) {
  const reasons = [];
  for (const p of requiredPlatforms) {
    const draft = p.draftStage || '';
    const publish = p.publishStatus || '';
    if (!draft && !publish) { reasons.push(`${p.platformName || p.platform}：缺少任务状态`); continue; }
    // 模拟阶段：除非该平台已人工确认正式发布，否则不满足归档门槛（草稿不等于已发布）。
    if (publish !== '人工确认已发布' && publish !== '已正式发布') {
      reasons.push(`${p.platformName || p.platform}：尚未人工确认正式发布（当前 ${publish || draft}）`);
    }
  }
  return { packageId, ready: reasons.length === 0, reasons };
}

export { writeJsonAtomic, resolveStrictDir };
