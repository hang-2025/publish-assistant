import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolveInside, validateRootDir, assertRootSetIndependent } from '../lib/security.mjs';
import { scanRoot } from '../lib/scanner.mjs';
import { inspectPackage, readImageAsDataUrl, hashImageFile, MAX_TOTAL_BYTES } from '../lib/package.mjs';
import { buildSendSnapshot, makeTaskKey } from '../lib/snapshot.mjs';
import { TaskStore } from '../lib/tasks.mjs';
import { classifyTaskId, previewRegistration } from '../lib/excel-mapping.mjs';
import { checkRealActionGate, getCapabilities, PLATFORM_CAPABILITIES } from '../lib/capabilities.mjs';
import { ACCEPTANCE_BUILD, LOCAL_PROTOCOL, SERVICE_VERSION } from '../lib/build-info.mjs';
import { archiveGateForSharedPackage } from '../lib/archive-sim.mjs';
import {
  SITE_KEYS, validSiteKey, buildPublishPreview, startSimulatedPublish,
  assertPackageSiteBinding, allowedSiteKeysForSegments,
} from '../lib/official-flow.mjs';
import { InMemoryArticleRepository } from '../repositories/article-repository.mjs';
import { TaskRepository } from '../repositories/task-repository.mjs';
import { ReadOnlyExcelRepository } from '../repositories/excel-repository.mjs';
import { ArticleService } from './article-service.mjs';
import { ZhihuDraftService } from './zhihu-draft-service.mjs';
import { createCommandRouter } from '../routes/command-router.mjs';
import { createLocalApiServer } from '../routes/local-api.mjs';
import { platformRegistry } from '../platforms/registry.mjs';

/**
 * 易造发布助手 · 本地服务（阶段 3：仅新增受保护的知乎单篇保存草稿；其他真实动作继续关闭）
 *
 * 安全边界（对应审查要求二.1/2/3）：
 * - 只绑定 127.0.0.1；Host 必须是 127.0.0.1:PORT 或 localhost:PORT；
 * - Origin 必须是 chrome-extension:// 协议；首次持有效令牌的扩展 ID 会被绑定并持久化，
 *   之后其他扩展即使能访问 localhost 也会被拒绝（网页 Origin 一律 403）；
 * - 除 /api/health（仅返回版本，无敏感信息）外，所有命令需要
 *   Authorization: Bearer <token>；令牌首次启动时生成，写入 data/token 文件并打印一次，
 *   由用户手工粘贴到插件工作台完成配对——任何匿名接口都不发放令牌，
 *   令牌不出现在 URL、查询参数和日志中；
 * - 命令走白名单（合计 25 条）：
 *     · 阶段1A 4 条：getConfig / setConfig / scan / getPackage；
 *     · 阶段1B 5 条：prepareOfficialTask / simulateOfficialTask / getTasks / getTask / removeTask；
 *     · 阶段1C 1 条：previewExcelRegistration（只读登记匹配预览）；
 *     · 阶段1D/2H 2 条：getCapabilities / checkRealActionGate（能力表与真实动作闸门检查）；
 *     · 阶段2A 1 条：preflightPackage（发布前总预演，只读）；
 *     · 阶段2B 2 条：getShareableConfigTemplate / importShareableConfigTemplate（不含个人路径/令牌）；
 *     · 阶段2C 1 条：previewArchiveGate（共享包归档门槛预览，只读）；
 *     · 阶段2D 1 条：confirmPublishedSimulated（人工确认发布结果的模拟状态更新）；
 *     · 阶段2E 1 条：confirmExcelRegisteredSimulated（人工确认 Excel 登记的模拟状态更新）；
 *     · 阶段2F 1 条：confirmArchivedSimulated（人工确认归档的模拟状态更新）；
 *     · 阶段2I 1 条：generateRealExecutionChecklist（真实执行验收单，只读生成）；
 *     · 阶段3 5 条：prepare/begin/advance/complete/failZhihuDraft（仅知乎保存草稿）；
 *   payload 用严格 schema（assertAllowedKeys），不接受任意路径/URL/命令名；
 * - getPackage / 发送快照只接受扫描时签发的受控 packageId，不接受任何路径；
 *   服务端用 realpath（解析 junction/符号链接）复核包与每张图片仍位于授权根目录之内。
 *
 * 阶段1B~1D 边界：
 * - prepareOfficialTask 只生成不可变发送快照 + 执行预览，不创建任务、不启动执行器；
 * - simulateOfficialTask 走模拟状态机，推进到「等待用户最终提交（模拟）」，绝不自动发布；
 * - Excel 只读映射原型可通过已配置的登记表路径做匹配预览，但不写入任何单元格；
 * - checkRealActionGate 默认返回 allowed=false；仅内部经过当次确认及快照复核的 zhihu.saveDraft 可放行；
 * - 公开发布、Excel 写入、文章归档等命令一概不提供。
 *
 * 审查返工（2026-09-04）新增的两条硬约束：
 * - 【P0-1】发布包与目标平台必须服务端绑定：prepareOfficialTask / simulateOfficialTask
 *   都先由受控相对路径推导该包允许的站点键（见 lib/official-flow.mjs#assertPackageSiteBinding），
 *   与客户端传入的 siteKey 不一致时直接拒绝——不生成预览、不创建任务、不启动执行器。
 *   客户端仍然只能传受控 packageId，不能传路径，也不能“声称”自己的平台。
 * - 【P0-2】跨进程站点锁（lib/mutex.mjs）只在遵循同一锁协议的新服务进程之间生效。
 *   旧助手未接入本协议，本轮不修改、不启动它，因此不得把本锁描述成“与旧执行器互斥”。
 */

const __dirname = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DATA_DIR = process.env.YIZ_DATA_DIR ? path.resolve(process.env.YIZ_DATA_DIR) : path.join(__dirname, 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const TOKEN_PATH = path.join(DATA_DIR, 'token');
const TASK_DIR = path.join(DATA_DIR, 'tasks');
const LOCK_DIR = path.join(DATA_DIR, 'locks');
const PORT = Number(process.env.YIZ_PORT || (process.argv.includes('--port') ? process.argv[process.argv.indexOf('--port') + 1] : 8788));
const VERSION = SERVICE_VERSION;
const MAX_BODY_BYTES = 1024 * 1024; // 1MB：setConfig / 快照命令之外没有大载荷
const PROTOCOL = LOCAL_PROTOCOL;
const store = new TaskStore(TASK_DIR);
const taskRepository = new TaskRepository(store);
const articleRepository = new InMemoryArticleRepository();
const articleService = new ArticleService(articleRepository);
const excelRepository = new ReadOnlyExcelRepository();

const DEFAULT_PLATFORM_VALUES = {
  'eyzao.com': ['eyzao.com', 'www.eyzao.com'],
  'eyzao.cn': ['eyzao.cn', 'www.eyzao.cn'],
  'yzfanglei.com': ['yzfanglei.com', 'www.yzfanglei.com'],
  baijiahao: ['baijiahao', '百家号'],
  zhihu: ['zhihu', '知乎'],
  sohu: ['sohu', '搜狐', '搜狐号'],
};
const DEFAULT_CAPTION_POLICY = {
  official: 'keep-existing-only',
  baijiahao: 'keep-existing-only',
  draft: 'use-existing-alt-after-preview',
};
const CAPTION_POLICY_VALUES = new Set(['keep-existing-only', 'use-existing-alt-after-preview', 'disabled']);
const CAPTION_POLICY_KEYS = ['official', 'baijiahao', 'draft'];

function defaultConfig() {
  return {
    version: 2,
    roots: { unpublished: '', published: '', archive: '' },
    excel: { planPath: '', sheetName: '' },
    mappings: { platformValues: DEFAULT_PLATFORM_VALUES },
    captionPolicy: DEFAULT_CAPTION_POLICY,
    security: { trustedOrigin: '' },
  };
}

function safePlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} 必须是对象`);
  return value;
}

function sanitizePlatformValues(input = DEFAULT_PLATFORM_VALUES) {
  safePlainObject(input, 'platformValues');
  const out = Object.create(null);
  for (const [key, values] of Object.entries({ ...DEFAULT_PLATFORM_VALUES, ...input })) {
    if (!/^[a-z0-9._-]{2,40}$/i.test(key)) throw new Error(`平台映射键无效：${String(key).slice(0, 40)}`);
    if (!Array.isArray(values)) throw new Error(`平台映射 ${key} 必须是文本数组`);
    const cleaned = [];
    for (const raw of values) {
      const value = String(raw || '').trim().slice(0, 80);
      if (value && !cleaned.includes(value)) cleaned.push(value);
      if (cleaned.length >= 20) break;
    }
    if (!cleaned.length) throw new Error(`平台映射 ${key} 至少需要一个表格值`);
    out[key] = cleaned;
  }
  return out;
}

function sanitizeCaptionPolicy(input = DEFAULT_CAPTION_POLICY) {
  safePlainObject(input, 'captionPolicy');
  const out = { ...DEFAULT_CAPTION_POLICY };
  for (const [key, value] of Object.entries(input)) {
    if (!CAPTION_POLICY_KEYS.includes(key)) throw new Error(`图注策略键无效：${String(key).slice(0, 40)}`);
    if (!CAPTION_POLICY_VALUES.has(value)) throw new Error(`图注策略 ${key} 的值无效`);
    out[key] = value;
  }
  return out;
}

function normalizeConfig(config) {
  const base = defaultConfig();
  const source = config || {};
  const sourceMappings = source.mappings || {};
  return {
    ...base,
    ...source,
    roots: { ...base.roots, ...(source.roots || {}) },
    excel: { ...base.excel, ...(source.excel || {}) },
    mappings: {
      ...base.mappings,
      ...sourceMappings,
      platformValues: sanitizePlatformValues(sourceMappings.platformValues || base.mappings.platformValues),
    },
    captionPolicy: sanitizeCaptionPolicy(source.captionPolicy || base.captionPolicy),
    security: { ...base.security, ...(source.security || {}) },
  };
}

// ---------- 令牌 ----------
async function loadOrCreateToken() {
  try {
    const token = (await fs.readFile(TOKEN_PATH, 'utf8')).trim();
    if (/^[0-9a-f]{64}$/.test(token)) return { token, created: false };
  } catch { /* 首次启动 */ }
  const token = crypto.randomBytes(32).toString('hex');
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(TOKEN_PATH, token, { encoding: 'utf8', mode: 0o600 });
  return { token, created: true };
}

// ---------- 配置（只写本服务自身 data/config.json，不碰文章与 Excel） ----------
async function loadConfig() {
  try { return normalizeConfig(JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8'))); }
  catch { return defaultConfig(); }
}

async function saveConfig(config) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = CONFIG_PATH + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(normalizeConfig(config), null, 2), 'utf8');
  await fs.rename(tmp, CONFIG_PATH);
}

// ---------- 受控包 ID ----------
const packageIndex = new Map(); // packageId -> { rootName, relativePath }
function makePackageId(rootName, relativePath) {
  const digest = crypto.createHash('sha256').update(`${rootName}\0${relativePath}`).digest('hex').slice(0, 24);
  return `pkg-${digest}`;
}

// ---------- 命令实现 ----------
async function cmdGetConfig() {
  const config = await loadConfig();
  const roots = {};
  for (const [key, value] of Object.entries(config.roots || {})) {
    roots[key] = value && typeof value === 'string'
      ? { configured: true, exists: fss.existsSync(value), resolved: value }
      : { configured: false };
  }
  const excelPath = config.excel?.planPath || '';
  return {
    protocol: PROTOCOL,
    version: VERSION,
    roots,
    excel: excelPath
      ? { configured: true, exists: fss.existsSync(excelPath), resolved: excelPath, sheetName: config.excel?.sheetName || '' }
      : { configured: false, sheetName: config.excel?.sheetName || '' },
    mappings: config.mappings || { platformValues: DEFAULT_PLATFORM_VALUES },
    captionPolicy: config.captionPolicy || DEFAULT_CAPTION_POLICY,
  };
}

async function validateExcelFile(file) {
  if (!file) return '';
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error('excelPath 必须是绝对路径');
  if (!/\.xlsx$/i.test(file)) throw new Error('excelPath 必须指向 .xlsx 文件');
  const abs = path.resolve(file);
  const lst = await fs.lstat(abs);
  if (lst.isSymbolicLink()) throw new Error('excelPath 不能是符号链接/junction');
  const real = await fs.realpath(abs);
  const st = await fs.stat(real);
  if (!st.isFile()) throw new Error(`excelPath 不是文件：${file}`);
  return real;
}

function extractPlanTaskId(...values) {
  for (const value of values) {
    const text = String(value || '');
    const hits = text.match(/PL-\s*\d{4}\s*-\s*\d{1,4}(?:\s*-\s*[A-Za-z0-9]{1,4})?/ig) || [];
    for (const hit of hits) {
      const normalized = classifyTaskId(hit).normalized;
      if (normalized) return normalized;
    }
  }
  return '';
}

function inferPlanQuery({ info, relativePath, siteKey, plTaskId }) {
  const seo = info?.seo || {};
  const segments = String(relativePath || '').split('/').filter(Boolean);
  const sourcePlatform = siteKey === 'baijiahao'
    ? '百家号'
    : (siteKey || segments[1] || '');
  const taskId = classifyTaskId(plTaskId).normalized || extractPlanTaskId(
    plTaskId,
    seo['任务编号'], seo['计划编号'], seo['PL任务编号'], seo['PL编号'],
    seo['内容标题'], seo['SEO标题'], info?.title, info?.coreQuestion, relativePath,
  );
  return {
    plTaskId: taskId,
    platform: sourcePlatform,
    category: seo['内容栏目'] || segments[2] || '',
    title: info?.title || seo['内容标题'] || seo['SEO标题'] || '',
    date: segments.find((segment) => /^\d{4}-\d{1,2}-\d{1,2}/.test(segment)) || '',
  };
}

function platformValueCandidates(config, siteKey) {
  const mapped = config.mappings?.platformValues?.[siteKey] || [];
  return [...new Set([siteKey, ...mapped].map((v) => String(v || '').trim()).filter(Boolean))];
}

function previewRegistrationWithPlatformCandidates({ workbook, sheetName, query, platformCandidates }) {
  const candidates = platformCandidates?.length ? platformCandidates : [query.platform].filter(Boolean);
  let first = null;
  for (const platform of candidates) {
    const next = previewRegistration({ workbook, sheetName, query: { ...query, platform } });
    const decorated = { ...next, usedPlatformValue: platform, triedPlatformValues: candidates };
    if (!first) first = decorated;
    if (next.ok && next.resolution?.kind === 'unique') return decorated;
  }
  return first || previewRegistration({ workbook, sheetName, query });
}

async function cmdSetConfig(payload) {
  assertAllowedKeys(payload || {}, ['unpublished', 'published', 'archive', 'excelPath', 'excelSheet', 'platformValues', 'captionPolicy']);
  const { unpublished, published, archive } = payload || {};
  const current = await loadConfig();
  const roots = {
    unpublished: current.roots?.unpublished || '',
    published: current.roots?.published || '',
    archive: current.roots?.archive || '',
  };
  const validated = {};
  for (const [key, value] of Object.entries({ unpublished, published, archive })) {
    if (!(key in (payload || {}))) {
      if (roots[key]) validated[key] = roots[key];
      continue;
    }
    if (!value) { roots[key] = ''; continue; }
    if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error(`${key} 必须是绝对路径`);
    validated[key] = await validateRootDir(value); // 不存在/不是目录 → 报错，不创建
    roots[key] = validated[key];
  }
  assertRootSetIndependent(validated);
  const excel = {
    planPath: current.excel?.planPath || '',
    sheetName: current.excel?.sheetName || '',
  };
  if ('excelPath' in (payload || {})) excel.planPath = await validateExcelFile(payload.excelPath);
  if ('excelSheet' in (payload || {})) {
    if (payload.excelSheet && typeof payload.excelSheet !== 'string') throw new Error('excelSheet 必须是文本');
    excel.sheetName = String(payload.excelSheet || '').trim().slice(0, 80);
  }
  const mappings = { ...(current.mappings || {}), platformValues: current.mappings?.platformValues || DEFAULT_PLATFORM_VALUES };
  const captionPolicy = current.captionPolicy || DEFAULT_CAPTION_POLICY;
  if ('platformValues' in (payload || {})) mappings.platformValues = sanitizePlatformValues(payload.platformValues);
  if ('captionPolicy' in (payload || {})) Object.assign(captionPolicy, sanitizeCaptionPolicy(payload.captionPolicy));
  await saveConfig({
    version: 2,
    roots,
    excel,
    mappings,
    captionPolicy,
    security: { trustedOrigin: STATE.trustedOrigin || current.security?.trustedOrigin || '' },
  });
  packageIndex.clear();
  await articleRepository.clear();
  return { ok: true, roots: { unpublished: roots.unpublished || '', published: roots.published || '', archive: roots.archive || '' }, excel, mappings, captionPolicy };
}

async function cmdScan(payload) {
  const config = await loadConfig();
  const rootName = payload?.root;
  if (!['unpublished', 'published'].includes(rootName)) throw new Error('root 必须是 unpublished 或 published');
  const rootDir = config.roots?.[rootName];
  if (!rootDir) throw new Error('尚未配置该目录，请先在设置中配置');
  const packages = await scanRoot(rootDir, rootName, makePackageId);
  for (const pkg of packages) {
    if (pkg.packageId) packageIndex.set(pkg.packageId, { rootName, relativePath: pkg.relativePath });
  }
  await articleService.indexScanResults(packages, { rootName });
  return { root: rootName, count: packages.length, packages };
}

async function cmdGetPackage(payload) {
  const packageId = payload?.packageId;
  if (!packageId || !packageIndex.has(packageId)) {
    throw new Error('未知或已过期的包 ID（服务重启后请重新扫描）');
  }
  const { rootName, relativePath } = packageIndex.get(packageId);
  const config = await loadConfig();
  const rootDir = config.roots?.[rootName];
  if (!rootDir) throw new Error('授权目录配置已变化，请重新配置');
  const { absolutePath } = await resolveInside(rootDir, relativePath); // realpath + 越界复核

  const info = await inspectPackage(absolutePath);

  // 读取图片内容（含 SHA-256，用于重复图片检测与后续内容绑定）
  const images = [];
  let total = 0;
  const hashes = new Map();
  for (const img of info.images) {
    const abs = path.join(absolutePath, img.dir, img.name);
    // 图片本身也可能是指向外部的链接 → 逐张复核
    const { absolutePath: safeAbs } = await resolveInside(rootDir, path.relative(path.resolve(rootDir), abs));
    try {
      const { dataUrl, sha256, bytes } = await readImageAsDataUrl(safeAbs);
      total += bytes;
      if (total > MAX_TOTAL_BYTES) throw new Error('发布包图片总量超过24MB，请压缩后重试');
      const duplicateOf = hashes.get(sha256);
      hashes.set(sha256, img.name);
      images.push({
        number: img.number, name: img.name, dir: img.dir, bytes, sha256, dataUrl,
        alt: info.alts.find((a) => a.number === img.number)?.alt || '',
        altSource: info.altSource,
        duplicateOf: duplicateOf || null, // 同一照片重复出现（按内容指纹）
      });
    } catch (err) {
      images.push({ number: img.number, name: img.name, dir: img.dir, bytes: 0, sha256: '', dataUrl: '', alt: info.alts.find((a) => a.number === img.number)?.alt || '', altSource: info.altSource, duplicateOf: null, error: err.message });
    }
  }
  const duplicateIssues = images.filter((i) => i.duplicateOf).map((i) => `重复图片（内容相同）：${i.dir}/${i.name} 与 ${i.duplicateOf} 相同，可复用上传但图注可不同`);

  const response = {
    packageId,
    root: rootName,
    relativePath,
    title: info.title,
    seo: info.seo,
    coreQuestion: info.coreQuestion,
    html: info.html,
    alts: info.alts,
    altSource: info.altSource,
    images,
    occurrences: info.occurrences,
    fileList: info.fileList,
    issues: [...info.issues, ...duplicateIssues],
    notes: info.notes,
    protocol: PROTOCOL,
  };
  await articleService.enrichPackage(response);
  return response;
}

// ---------- 阶段1B~1D：发送快照 / 官网百家号骨架 / 任务状态 / 只读预览 / 安全闸门 ----------
const PKG_ID_RE = /^pkg-[0-9a-f]{24}$/;
const TASK_ID_RE = /^tsk_[0-9]+_[0-9a-f]{8}$/;

/** 校验 payload 只含允许的顶层键，杜绝正文/URL 触发额外动作。 */
function assertAllowedKeys(payload, allowed) {
  for (const key of Object.keys(payload || {})) {
    if (!allowed.includes(key)) throw new Error(`未知参数：${String(key).slice(0, 40)}`);
  }
}

/** 定位一个已扫描的发布包，注入只读图片哈希读取器（逐张 realpath 复核越界）。 */
async function loadSnapshotContext(packageId) {
  if (!PKG_ID_RE.test(String(packageId || ''))) throw new Error('packageId 必须是扫描签发的包 ID');
  if (!packageIndex.has(packageId)) throw new Error('未知或已过期的包 ID（服务重启后请重新扫描）');
  const { rootName, relativePath } = packageIndex.get(packageId);
  const config = await loadConfig();
  const rootDir = config.roots?.[rootName];
  if (!rootDir) throw new Error('授权目录配置已变化，请重新配置');
  const { absolutePath } = await resolveInside(rootDir, relativePath);
  const info = await inspectPackage(absolutePath);
  const readAsset = async (asset) => {
    // 图片可能本身是指向外部的链接 → 逐张按授权根目录 realpath 复核
    const rel = `${relativePath}/${asset.dir}/${asset.name}`;
    const { absolutePath: safeAbs } = await resolveInside(rootDir, rel);
    return hashImageFile(safeAbs);
  };
  return { absolutePath, info, rootName, relativePath, segments: String(relativePath || '').split('/').filter(Boolean), readAsset };
}

/**
 * 【审查返工 P0-1】包↔平台绑定：站点只能由服务端从受控相对路径推导，
 * 客户端传入的 siteKey 必须等于推导结果，否则拒绝（不生成预览、不创建任务）。
 */
function enforcePackageSiteBinding({ packageId, relativePath, siteKey }) {
  const binding = assertPackageSiteBinding({ packageId, relativePath, siteKey });
  const derived = allowedSiteKeysForSegments(binding.segments);
  return { segments: binding.segments, allowedSiteKeys: derived.siteKeys };
}

function sanitizeTask(t) {
  if (!t) return null;
  return {
    taskId: t.taskId,
    taskKey: t.taskKey,
    mode: t.mode || 'simulate',
    packageId: t.packageId,
    rootName: t.rootName,
    relativePath: t.relativePath,
    segments: t.segments || [],
    platform: t.platform,
    platformName: t.platformName,
    platformKind: t.platformKind,
    accountId: t.accountId,
    accountLabel: t.accountLabel,
    title: t.title,
    contentVersion: t.contentVersion,
    contentVersionShort: t.contentVersionShort,
    snapshotId: t.snapshotId,
    snapshot: t.snapshot || null,
    status: t.status || '',
    draftResult: t.draftResult || null,
    runState: t.runState,
    draft: t.states?.draft || {},
    publish: t.states?.publish || {},
    excel: t.states?.excel || {},
    archive: t.states?.archive || {},
    history: t.history || [],
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    finishedAt: t.finishedAt || '',
  };
}

async function loadZhihuDraftSnapshot(packageId) {
  const context = await loadSnapshotContext(packageId);
  const derived = derivePackagePlatformsForPreflight(context.segments);
  if (derived.siteKeys.length !== 1 || derived.siteKeys[0] !== 'zhihu') {
    throw new Error(`发布包与知乎不匹配：目录推导为 ${derived.siteKeys.join(', ') || '无法推导'}`);
  }
  const snapshot = await buildSendSnapshot({
    info: context.info, readAsset: context.readAsset,
    source: { packageId, rootName: context.rootName, relativePath: context.relativePath },
    requireAltPerImage: true,
  });
  return { ...context, snapshot };
}

const zhihuDraftService = new ZhihuDraftService({ store, loadSnapshot: loadZhihuDraftSnapshot });

async function cmdPrepareZhihuDraft(payload) {
  assertAllowedKeys(payload || {}, ['packageId', 'userConfirmed']);
  const result = await platformRegistry.get('zhihu').createTask({
    createDraftTask: () => zhihuDraftService.prepare(payload || {}),
  });
  return { mode: 'zhihu-draft', ...result, task: sanitizeTask(result.task), busy: sanitizeTask(result.busy) };
}

async function cmdBeginZhihuDraft(payload) {
  assertAllowedKeys(payload || {}, ['taskId', 'snapshotId', 'userConfirmed']);
  const result = await platformRegistry.get('zhihu').saveDraft({
    saveDraft: () => zhihuDraftService.begin(payload || {}),
  });
  return { mode: 'zhihu-draft', ...result, task: sanitizeTask(result.task) };
}

async function cmdAdvanceZhihuDraft(payload) {
  assertAllowedKeys(payload || {}, ['taskId', 'status', 'detail']);
  return { mode: 'zhihu-draft', task: sanitizeTask(await zhihuDraftService.progress(payload || {})) };
}

async function cmdCompleteZhihuDraft(payload) {
  assertAllowedKeys(payload || {}, ['taskId', 'result']);
  return { mode: 'zhihu-draft', task: sanitizeTask(await zhihuDraftService.complete(payload || {})) };
}

async function cmdFailZhihuDraft(payload) {
  assertAllowedKeys(payload || {}, ['taskId', 'error']);
  return { mode: 'zhihu-draft', task: sanitizeTask(await zhihuDraftService.fail(payload || {})) };
}

/** 官网/百家号执行预览：只生成发送快照 + 执行预览，不创建任务、不启动执行器。 */
async function cmdPrepareOfficialTask(payload) {
  assertAllowedKeys(payload, ['packageId', 'siteKey']);
  const siteKey = payload?.siteKey;
  if (!validSiteKey(siteKey)) throw new Error(`siteKey 必须是已接入站点：${SITE_KEYS.join(', ')}`);
  const { rootName, relativePath, info, readAsset } = await loadSnapshotContext(payload?.packageId);
  enforcePackageSiteBinding({ packageId: payload.packageId, relativePath, siteKey });
  const snapshot = await buildSendSnapshot({
    info, readAsset,
    source: { packageId: payload.packageId, rootName, relativePath },
    requireAltPerImage: true,
  });
  const preview = buildPublishPreview({ snapshot, siteKey });
  return platformRegistry.get(siteKey).prepare({ prepare: async () => ({
    mode: 'preview',
    preview,
    snapshot: {
      snapshotId: snapshot.snapshotId,
      gate: snapshot.gate,
      contentVersion: snapshot.source.contentVersion,
      contentVersionShort: snapshot.source.contentVersion.slice(0, 12),
      assets: snapshot.assets,
      occurrences: snapshot.occurrences,
    },
    taskKey: makeTaskKey({
      packageId: payload.packageId,
      platform: siteKey,
      accountId: `${siteKey}-占位账号`,
      contentVersion: snapshot.source.contentVersion,
    }),
  }) });
}

/** 官网/百家号模拟状态机：幂等创建任务并推进到「等待用户最终提交（模拟）」。 */
async function cmdSimulateOfficialTask(payload) {
  assertAllowedKeys(payload, ['packageId', 'siteKey']);
  const siteKey = payload?.siteKey;
  if (!validSiteKey(siteKey)) throw new Error(`siteKey 必须是已接入站点：${SITE_KEYS.join(', ')}`);
  const { rootName, relativePath, info, readAsset } = await loadSnapshotContext(payload?.packageId);
  enforcePackageSiteBinding({ packageId: payload.packageId, relativePath, siteKey });
  const snapshot = await buildSendSnapshot({
    info, readAsset,
    source: { packageId: payload.packageId, rootName, relativePath },
    requireAltPerImage: true,
  });
  if (!snapshot.gate.executable) {
    return { mode: 'blocked', ok: false, gate: snapshot.gate, siteKey, reason: '发送快照存在阻塞问题，未创建模拟任务' };
  }
  const start = await platformRegistry.get(siteKey).createTask({
    createSimulatedTask: () => startSimulatedPublish({ store, snapshot, siteKey, lockDir: LOCK_DIR }),
  });
  const task = start.taskId
    ? sanitizeTask(await store.getTask(start.taskId))
    : (start.task ? sanitizeTask(start.task) : null);
  return {
    mode: 'simulate',
    started: start.started,
    siteKey,
    reason: start.reason,
    detail: start.detail || '',
    ...(task ? { task } : {}),
    busy: start.busy ? sanitizeTask(start.busy) : undefined,
  };
}

async function cmdGetTasks() {
  const tasks = (await taskRepository.listLegacy()).map(sanitizeTask).filter(Boolean);
  return { count: tasks.length, tasks };
}

async function cmdGetTask(payload) {
  assertAllowedKeys(payload, ['taskId']);
  const taskId = payload?.taskId;
  if (!TASK_ID_RE.test(String(taskId || ''))) throw new Error('taskId 格式无效');
  const task = sanitizeTask(await taskRepository.getById(taskId));
  if (!task) throw new Error('找不到该任务（可能已被清除）');
  return { task };
}

async function cmdRemoveTask(payload) {
  assertAllowedKeys(payload, ['taskId']);
  const taskId = payload?.taskId;
  if (!TASK_ID_RE.test(String(taskId || ''))) throw new Error('taskId 格式无效');
  const result = await taskRepository.remove(taskId);
  if (!result.removed) throw new Error(result.reason || '不允许删除该任务记录');
  return { removed: true };
}

function sanitizePublicUrl(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (text.length > 500) throw new Error('正式链接过长');
  let url;
  try { url = new URL(text); } catch { throw new Error('正式链接必须是 http/https URL'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('正式链接必须是 http/https URL');
  url.hash = '';
  return url.toString();
}

async function cmdConfirmPublishedSimulated(payload) {
  assertAllowedKeys(payload || {}, ['taskId', 'publicUrl', 'note']);
  const taskId = payload?.taskId;
  if (!TASK_ID_RE.test(String(taskId || ''))) throw new Error('taskId 格式无效');
  const task = await store.confirmPublishedSimulated(taskId, {
    publicUrl: sanitizePublicUrl(payload?.publicUrl || ''),
    note: payload?.note || '',
  });
  if (!task) throw new Error('找不到该任务（可能已被清除）');
  return {
    mode: 'confirm-published-simulated',
    simulatedOnly: true,
    task: sanitizeTask(task),
    notice: '仅更新本地模拟任务状态：未打开平台、未点击发布、未写 Excel、未移动或归档文件。',
  };
}

function shortText(value, label, max = 80) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' && typeof value !== 'number') throw new Error(`${label} 必须是文本`);
  return String(value).trim().slice(0, max);
}

async function cmdConfirmExcelRegisteredSimulated(payload) {
  assertAllowedKeys(payload || {}, ['taskId', 'sheetName', 'rowIndex', 'plTaskId', 'note']);
  const taskId = payload?.taskId;
  if (!TASK_ID_RE.test(String(taskId || ''))) throw new Error('taskId 格式无效');
  const task = await store.confirmExcelRegisteredSimulated(taskId, {
    sheetName: shortText(payload?.sheetName, 'sheetName', 80),
    rowIndex: shortText(payload?.rowIndex, 'rowIndex', 20),
    plTaskId: shortText(payload?.plTaskId, 'plTaskId', 40),
    note: shortText(payload?.note, 'note', 200),
  });
  if (!task) throw new Error('找不到该任务（可能已被清除）');
  return {
    mode: 'confirm-excel-registered-simulated',
    simulatedOnly: true,
    task: sanitizeTask(task),
    notice: '仅更新本地模拟任务状态：未读取写回真实 Excel、未移动或归档文件。',
  };
}

async function cmdConfirmArchivedSimulated(payload) {
  assertAllowedKeys(payload || {}, ['taskId', 'targetPreview', 'note']);
  const taskId = payload?.taskId;
  if (!TASK_ID_RE.test(String(taskId || ''))) throw new Error('taskId 格式无效');
  const task = await store.confirmArchivedSimulated(taskId, {
    targetPreview: shortText(payload?.targetPreview, 'targetPreview', 300),
    note: shortText(payload?.note, 'note', 200),
  });
  if (!task) throw new Error('找不到该任务（可能已被清除）');
  return {
    mode: 'confirm-archived-simulated',
    simulatedOnly: true,
    task: sanitizeTask(task),
    notice: '仅更新本地模拟任务状态：未复制、未移动、未删除任何文件。',
  };
}

/** 阶段1C：按已配置台账路径做“只读登记匹配预览”，不写 Excel、不落任务、不归档。 */
async function cmdPreviewExcelRegistration(payload) {
  assertAllowedKeys(payload, ['packageId', 'siteKey', 'plTaskId']);
  const siteKey = payload?.siteKey;
  if (siteKey && !validSiteKey(siteKey)) throw new Error(`siteKey 必须是已接入站点：${SITE_KEYS.join(', ')}`);
  const config = await loadConfig();
  const excelPath = await validateExcelFile(config.excel?.planPath || '');
  if (!excelPath) throw new Error('尚未配置登记表 Excel，请先在工作台保存 .xlsx 路径');
  const { relativePath, info } = await loadSnapshotContext(payload?.packageId);
  if (siteKey) enforcePackageSiteBinding({ packageId: payload.packageId, relativePath, siteKey });
  const derived = allowedSiteKeysForSegments(String(relativePath || '').split('/').filter(Boolean));
  const effectiveSiteKey = siteKey || derived.siteKeys[0] || '';
  if (!effectiveSiteKey) throw new Error('无法从该包的受控目录推导登记平台，请先人工绑定平台');
  const query = inferPlanQuery({ info, relativePath, siteKey: effectiveSiteKey, plTaskId: payload?.plTaskId });
  const workbook = await excelRepository.read(excelPath);
  const registration = previewRegistrationWithPlatformCandidates({
    workbook,
    sheetName: config.excel?.sheetName || '',
    query,
    platformCandidates: platformValueCandidates(config, effectiveSiteKey),
  });
  return {
    mode: 'excel-registration-preview',
    readOnly: true,
    excel: {
      configured: true,
      resolved: excelPath,
      sheetName: config.excel?.sheetName || '',
    },
    query,
    registration,
    notice: '只读预览：未写入 Excel、未登记任务、未移动或归档文章包。',
  };
}

async function cmdGetCapabilities(payload) {
  assertAllowedKeys(payload || {}, []);
  return getCapabilities();
}

async function cmdCheckRealActionGate(payload) {
  assertAllowedKeys(payload || {}, ['action', 'platform']);
  return checkRealActionGate(payload || {});
}

function derivePackagePlatformsForPreflight(segments) {
  const official = allowedSiteKeysForSegments(segments);
  if (official.siteKeys.length || ['官网', 'website', '官网站点'].includes(segments[0])) return official;
  if (!['主流平台', 'mainstream', 'platform', '平台'].includes(segments[0])) return official;
  const aliases = new Map([
    ['百家号', 'baijiahao'], ['baijiahao', 'baijiahao'], ['baijia', 'baijiahao'],
    ['知乎', 'zhihu'], ['zhihu', 'zhihu'],
    ['搜狐', 'sohu'], ['搜狐号', 'sohu'], ['sohu', 'sohu'],
    ['头条', 'toutiao'], ['头条号', 'toutiao'], ['toutiao', 'toutiao'],
    ['网易', 'netease'], ['网易号', 'netease'], ['netease', 'netease'],
    ['小红书', 'xiaohongshu'], ['xiaohongshu', 'xiaohongshu'],
  ]);
  const found = [...new Set(segments.slice(1).map((item) => aliases.get(String(item).toLowerCase()) || aliases.get(String(item))).filter(Boolean))];
  return found.length === 1
    ? { ...official, siteKeys: found, reason: 'ok' }
    : { ...official, siteKeys: [], reason: found.length > 1 ? `平台目录下出现多个平台段（${found.join(', ')}）` : official.reason };
}

/** 阶段2A：发布前总预演。整合发送快照、Excel 匹配、归档目标和真实动作闸门；只读、不执行。 */
async function cmdPreflightPackage(payload) {
  assertAllowedKeys(payload || {}, ['packageId', 'siteKey', 'platform', 'plTaskId']);
  const { rootName, relativePath, info, readAsset } = await loadSnapshotContext(payload?.packageId);
  const segments = String(relativePath || '').split('/').filter(Boolean);
  const derived = derivePackagePlatformsForPreflight(segments);
  const requestedPlatform = String(payload?.siteKey || payload?.platform || derived.siteKeys[0] || '').trim();
  const siteKey = validSiteKey(requestedPlatform) ? requestedPlatform : '';
  const knownPlatform = PLATFORM_CAPABILITIES.some((item) => item.id === requestedPlatform);
  if (requestedPlatform && !knownPlatform) throw new Error(`平台尚未登记能力：${requestedPlatform}`);
  if (requestedPlatform && !derived.siteKeys.includes(requestedPlatform)) {
    throw new Error(`发布包与目标平台不匹配：目录推导为 ${derived.siteKeys.join(', ') || '无法推导'}，请求为 ${requestedPlatform}`);
  }
  const blocks = [];
  const warnings = [];

  let snapshotPreview = null;
  if (siteKey || requestedPlatform === 'zhihu') {
    if (siteKey) enforcePackageSiteBinding({ packageId: payload.packageId, relativePath, siteKey });
    const snapshot = await buildSendSnapshot({
      info, readAsset,
      source: { packageId: payload.packageId, rootName, relativePath },
      requireAltPerImage: true,
    });
    const preview = siteKey
      ? buildPublishPreview({ snapshot, siteKey })
      : { platformName: '知乎', account: '当前 Chrome 知乎会话', finalAction: '保存草稿后等待用户检查' };
    snapshotPreview = {
      siteKey: siteKey || requestedPlatform,
      platformName: preview.platformName,
      account: preview.account,
      finalAction: preview.finalAction,
      gate: snapshot.gate,
      contentVersion: snapshot.source.contentVersion,
      contentVersionShort: snapshot.source.contentVersion.slice(0, 12),
      snapshotId: snapshot.snapshotId,
      imageCount: snapshot.content.imageCount,
      occurrenceCount: snapshot.occurrences.length,
    };
    blocks.push(...(snapshot.gate.blocks || []).map((b) => `发送快照：${b}`));
    warnings.push(...(snapshot.gate.warnings || []).map((w) => `发送快照：${w}`));
  } else {
    blocks.push(`平台未接入或无法从目录推导：${requestedPlatform || derived.reason || '未识别'}`);
  }

  const config = await loadConfig();
  let registration = { configured: false, status: 'missing-config', notice: '未配置登记表 Excel，无法预演登记匹配。' };
  if (config.excel?.planPath) {
    try {
      const excelPath = await validateExcelFile(config.excel.planPath);
      const query = inferPlanQuery({ info, relativePath, siteKey: siteKey || requestedPlatform, plTaskId: payload?.plTaskId });
      const workbook = await excelRepository.read(excelPath);
      const preview = previewRegistrationWithPlatformCandidates({
        workbook,
        sheetName: config.excel?.sheetName || '',
        query,
        platformCandidates: platformValueCandidates(config, siteKey || requestedPlatform),
      });
      registration = { configured: true, status: preview?.resolution?.kind || (preview.ok ? 'unknown' : 'error'), excelPath, sheetName: config.excel?.sheetName || '', query, preview };
      if (!preview.ok) blocks.push(`Excel：${preview.error}`);
      else if (preview.resolution?.kind !== 'unique') warnings.push(`Excel：${preview.resolution?.notice || '登记匹配需要人工确认'}`);
    } catch (err) {
      registration = { configured: true, status: 'error', notice: err.message };
      blocks.push(`Excel：${err.message}`);
    }
  } else {
    warnings.push('Excel：未配置登记表，只能继续预览，不能进入登记。');
  }

  const archiveRoot = config.roots?.archive || '';
  const archive = archiveRoot
    ? {
      configured: true,
      sourceRoot: rootName,
      sourceRelativePath: relativePath,
      targetRoot: archiveRoot,
      targetPreview: path.join(archiveRoot, relativePath),
      status: 'preview-only',
      notice: '只读归档预演：未复制、未移动、未删除任何文件。真实归档需所有平台发布状态满足后另行授权。',
    }
    : {
      configured: false,
      status: 'missing-config',
      notice: '未配置归档目标目录；正式发布后不能自动归档。',
    };
  if (!archiveRoot) warnings.push('归档：未配置归档目标目录。');

  const gates = {
    upload: checkRealActionGate({ action: 'upload', platform: siteKey || requestedPlatform }),
    publish: checkRealActionGate({ action: 'publish', platform: siteKey || requestedPlatform }),
    excelWrite: checkRealActionGate({ action: 'excelWrite', platform: siteKey || requestedPlatform }),
    archiveMove: checkRealActionGate({ action: 'archiveMove', platform: siteKey || requestedPlatform }),
  };

  return {
    mode: 'preflight',
    readOnly: true,
    package: { packageId: payload.packageId, rootName, relativePath, title: info.title, segments },
    platform: { requested: requestedPlatform, siteKey, derived: derived.siteKeys, reason: derived.reason || 'ok' },
    snapshot: snapshotPreview,
    registration,
    archive,
    gates,
    summary: {
      executableInThisBuild: false,
      blocks,
      warnings,
      nextStep: blocks.length ? '先修复阻塞项，再重新预演。' : '预演可读通过；真实上传/写表/归档仍需单独授权并通过闸门。',
    },
    notice: '阶段2A总预演只读：未上传、未公开发布、未写 Excel、未移动或归档文件。',
  };
}

function checklistLine(ok, text) {
  return `- [${ok ? 'x' : ' '}] ${text}`;
}

function formatChecklistGate(gate) {
  return `${gate.actionName}：${gate.allowed ? '允许' : '关闭'}（${gate.policy}）`;
}

function buildSmallSampleAcceptanceTemplate(preflight) {
  const platformKey = preflight.platform.siteKey || preflight.platform.requested;
  const platform = PLATFORM_CAPABILITIES.find((item) => item.id === platformKey);
  const isBaijiahao = platformKey === 'baijiahao';
  const platformName = platform?.name || platformKey || '未识别平台';
  const laterAuthorizedFlow = isBaijiahao
    ? [
      '后台只填写标题、正文、图片与已有 ALT/图注，先逐项人工对照。',
      '停在最终提交按钮之前，由用户检查预览；助手不得点击最终发布。',
      '由用户最终提交后，人工回填公开链接并确认发布结果。',
    ]
    : [
      '后台只填写栏目、标题、正文、图片与已有 ALT/图注，先逐项人工对照。',
      '停在最终提交按钮之前，由用户检查后台预览；助手不得点击最终发布。',
      '由用户最终提交后，人工回填公开链接并确认发布结果。',
    ];
  return [
    `# ${platformName} · 单篇小样本验收模板（后续授权阶段使用）`,
    ``,
    `> 当前构建只生成模板，不登录、不上传、不保存草稿、不发布、不写表、不归档。`,
    ``,
    `## 样本范围`,
    `- [ ] 仅 1 个专用测试文章包：${preflight.package.title || '待选择'}`,
    `- [ ] 使用专用测试账号和独立 Chrome 资料目录，不与旧助手共用。`,
    `- [ ] 使用测试 Excel 副本和测试归档目录，不接触真实台账与文章目录。`,
    `- [ ] 用户已在当次会话明确授权本平台、本文章和本次动作。`,
    ``,
    `## 执行前证据`,
    `- [ ] 发送快照 ID、内容版本、图片数量和正文出现位置已截图留档。`,
    `- [ ] 中文路径、乱序、重复图片、同名不同文件、缺图和图注冲突均已通过夹具回归。`,
    `- [ ] Excel 按“PL 任务编号 + 平台”唯一匹配；0 行只展示追加预览，多行必须停止。`,
    `- [ ] 共享发布包的其他平台任务不会因本平台完成而丢失源文件。`,
    ``,
    `## 后续获授权后的单篇验收步骤`,
    ...laterAuthorizedFlow.map((item) => `- [ ] ${item}`),
    `- [ ] 仅在确认正式发布后，才允许进入 Excel 登记确认。`,
    `- [ ] 仅在全部要求平台均确认发布且登记完成后，才允许进入可恢复归档。`,
    ``,
    `## 结果记录`,
    `- 平台：${platformName}`,
    `- 包 ID：${preflight.package.packageId}`,
    `- PL 任务编号：${preflight.registration?.query?.plTaskId || '待人工绑定'}`,
    `- 验收人：`,
    `- 验收时间：`,
    `- 后台草稿/预览截图：`,
    `- 公开链接（如用户已最终提交）：`,
    `- Excel 登记证据：`,
    `- 归档日志/恢复证据：`,
    `- 结论：通过 / 不通过 / 结果待核对`,
    `- 问题与回退记录：`,
    ``,
    `## 本阶段禁止项`,
    `- [x] 当前构建不提供真实上传或保存草稿命令。`,
    `- [x] 当前构建不提供自动最终提交命令。`,
    `- [x] 当前构建不提供真实 Excel 写入命令。`,
    `- [x] 当前构建不提供真实移动、删除或归档命令。`,
  ].join('\n');
}

/** 阶段2I/2J：真实执行验收材料生成。只读返回文本，不写文件、不创建任务、不执行真实动作。 */
async function cmdGenerateRealExecutionChecklist(payload) {
  assertAllowedKeys(payload || {}, ['packageId', 'siteKey', 'platform', 'plTaskId']);
  const preflight = await cmdPreflightPackage(payload || {});
  const gates = Object.values(preflight.gates || {});
  const closedCount = gates.filter((gate) => !gate.allowed).length;
  const allowedCount = gates.filter((gate) => gate.allowed).length;
  const registration = preflight.registration || {};
  const archive = preflight.archive || {};
  const snapshot = preflight.snapshot || {};
  const lines = [
    `# 易造发布助手 · 真实执行验收单（只读预览）`,
    ``,
    `生成时间：${new Date().toISOString()}`,
    `当前阶段：2J-acceptance-materials`,
    `结论：当前构建不可真实执行；${allowedCount} 项真实动作允许，${closedCount} 项真实动作关闭。`,
    ``,
    `## 文章包`,
    `- 标题：${preflight.package.title || '（未识别）'}`,
    `- 包 ID：${preflight.package.packageId}`,
    `- 来源目录：${preflight.package.relativePath}`,
    `- 来源根：${preflight.package.rootName}`,
    ``,
    `## 目标平台`,
    `- 请求平台：${preflight.platform.requested || '（未指定）'}`,
    `- 服务端绑定平台：${preflight.platform.siteKey || '（未接入/未推导）'}`,
    `- 推导依据：${(preflight.platform.derived || []).join('、') || preflight.platform.reason}`,
    ``,
    `## 发送快照`,
    checklistLine(Boolean(snapshot.snapshotId && snapshot.gate?.executable), `发送快照可读${snapshot.snapshotId ? `：${snapshot.snapshotId}` : ''}`),
    checklistLine(Boolean(snapshot.contentVersionShort), `内容版本已生成${snapshot.contentVersionShort ? `：${snapshot.contentVersionShort}` : ''}`),
    checklistLine(Boolean(snapshot.imageCount >= 0), `图片数量：${snapshot.imageCount ?? '未生成'}；正文出现位置：${snapshot.occurrenceCount ?? '未生成'}`),
    ``,
    `## Excel 登记`,
    checklistLine(Boolean(registration.configured), `已配置登记表：${registration.configured ? '是' : '否'}`),
    checklistLine(registration.status === 'unique', `匹配状态：${registration.status || '未知'}${registration.status === 'unique' ? '（唯一匹配）' : '（需要人工确认/补配置）'}`),
    `- 查询任务编号：${registration.query?.plTaskId || '未识别，需要人工绑定'}`,
    `- 查询平台：${registration.query?.platform || '未识别'}`,
    ``,
    `## 归档`,
    checklistLine(Boolean(archive.configured), `已配置归档目录：${archive.configured ? '是' : '否'}`),
    `- 目标预览：${archive.targetPreview || archive.notice || '未配置'}`,
    `- 注意：本验收单未复制、未移动、未删除任何文件。`,
    ``,
    `## 真实动作闸门`,
    ...gates.map((gate) => checklistLine(Boolean(gate.allowed), formatChecklistGate(gate))),
    ``,
    `## 阻塞与提醒`,
    ...(preflight.summary.blocks.length ? preflight.summary.blocks.map((item) => `- 阻塞：${item}`) : ['- 无发送快照级阻塞。']),
    ...(preflight.summary.warnings.length ? preflight.summary.warnings.map((item) => `- 提醒：${item}`) : ['- 无额外提醒。']),
    ``,
    `## 下一步`,
    `- 本单只是只读验收单，不是执行授权。`,
    `- 真实上传/保存草稿、公开发布、Excel 写入、归档移动仍需用户在后续阶段单独授权。`,
    `- 官网/百家号即使进入真实流程，也必须停在等待用户最终提交，不能自动点击最终发布。`,
  ];
  const acceptanceTemplateMarkdown = buildSmallSampleAcceptanceTemplate(preflight);
  const checklistMarkdown = lines.join('\n');
  return {
    mode: 'real-execution-checklist',
    readOnly: true,
    generatedAt: lines[2].replace('生成时间：', ''),
    package: preflight.package,
    platform: preflight.platform,
    summary: {
      executableInThisBuild: false,
      allowedRealActions: allowedCount,
      closedRealActions: closedCount,
      blocks: preflight.summary.blocks,
      warnings: preflight.summary.warnings,
    },
    checklistMarkdown,
    acceptanceTemplateMarkdown,
    exportMarkdown: `${checklistMarkdown}\n\n---\n\n${acceptanceTemplateMarkdown}\n`,
    exportFileName: `yizao-acceptance-${preflight.platform.siteKey || preflight.platform.requested || 'platform'}-${preflight.package.packageId.slice(0, 12)}.md`,
    notice: '只读验收材料：未上传、未公开发布、未写 Excel、未移动或归档文件，也未创建任务。',
  };
}

async function cmdGetShareableConfigTemplate(payload) {
  assertAllowedKeys(payload || {}, []);
  const config = await loadConfig();
  return {
    mode: 'shareable-config-template',
    template: {
      schema: 'yizao-config-template',
      version: 2,
      createdAt: new Date().toISOString(),
      excel: { sheetName: config.excel?.sheetName || '' },
      mappings: { platformValues: config.mappings?.platformValues || DEFAULT_PLATFORM_VALUES },
      captionPolicy: config.captionPolicy || DEFAULT_CAPTION_POLICY,
      notes: [
        '此模板只包含团队可复用规则，不包含个人目录、真实 Excel 路径、配对令牌、任务历史或日志。',
        '导入同事电脑后仍需各自配置文章目录、归档目录、Excel 文件和浏览器账号。',
      ],
    },
    excluded: [
      'roots.unpublished',
      'roots.published',
      'roots.archive',
      'excel.planPath',
      'security.trustedOrigin',
      'token',
      'tasks',
      'logs',
    ],
  };
}

async function cmdImportShareableConfigTemplate(payload) {
  assertAllowedKeys(payload || {}, ['template']);
  const template = safePlainObject(payload?.template, 'template');
  if (template.schema !== 'yizao-config-template') throw new Error('配置模板 schema 不匹配');
  if (Number(template.version || 0) !== 2) throw new Error('配置模板版本不支持');
  const current = await loadConfig();
  const excel = {
    planPath: current.excel?.planPath || '',
    sheetName: typeof template.excel?.sheetName === 'string'
      ? template.excel.sheetName.trim().slice(0, 80)
      : (current.excel?.sheetName || ''),
  };
  const mappings = {
    ...(current.mappings || {}),
    platformValues: sanitizePlatformValues(template.mappings?.platformValues || current.mappings?.platformValues || DEFAULT_PLATFORM_VALUES),
  };
  const captionPolicy = sanitizeCaptionPolicy(template.captionPolicy || current.captionPolicy || DEFAULT_CAPTION_POLICY);
  await saveConfig({
    version: 2,
    roots: current.roots || { unpublished: '', published: '', archive: '' },
    excel,
    mappings,
    captionPolicy,
    security: current.security || { trustedOrigin: STATE.trustedOrigin || '' },
  });
  return {
    mode: 'import-shareable-config-template',
    imported: true,
    excel: { sheetName: excel.sheetName },
    mappings,
    captionPolicy,
    notice: '已导入团队规则；个人目录、Excel 文件路径、配对令牌、任务历史均未从模板导入。',
  };
}

function platformInput(value, label = 'platform') {
  const text = String(value || '').trim();
  if (!/^[\p{Script=Han}a-zA-Z0-9._-]{1,40}$/u.test(text)) throw new Error(`${label} 格式无效`);
  return text;
}

async function cmdPreviewArchiveGate(payload) {
  assertAllowedKeys(payload || {}, ['packageId', 'requiredPlatforms']);
  const packageId = String(payload?.packageId || '');
  if (!PKG_ID_RE.test(packageId)) throw new Error('packageId 必须是扫描签发的包 ID');
  if (!packageIndex.has(packageId)) throw new Error('未知或已过期的包 ID（服务重启后请重新扫描）');
  if ('requiredPlatforms' in (payload || {}) && !Array.isArray(payload.requiredPlatforms)) throw new Error('requiredPlatforms 必须是数组');

  const tasks = (await store.listTasks()).filter((t) => t.packageId === packageId).map(sanitizeTask).filter(Boolean);
  const explicit = (payload.requiredPlatforms || []).map((item, index) => {
    if (typeof item === 'string') {
      const platform = platformInput(item, `requiredPlatforms[${index}]`);
      return { platform, platformName: platform };
    }
    safePlainObject(item, `requiredPlatforms[${index}]`);
    assertAllowedKeys(item, ['platform', 'platformName']);
    const platform = platformInput(item.platform, `requiredPlatforms[${index}].platform`);
    return { platform, platformName: String(item.platformName || platform).trim().slice(0, 80) };
  });
  const known = explicit.length
    ? explicit
    : tasks.map((t) => ({ platform: t.platform, platformName: t.platformName || t.platform }));
  const uniqueRequired = [];
  const seen = new Set();
  for (const item of known) {
    if (seen.has(item.platform)) continue;
    seen.add(item.platform);
    uniqueRequired.push(item);
  }
  const requiredPlatforms = uniqueRequired.map((item) => {
    const task = tasks.find((t) => t.platform === item.platform);
    return {
      platform: item.platform,
      platformName: item.platformName || task?.platformName || item.platform,
      draftStage: task?.draft?.stage || '',
      publishStatus: task?.publish?.status || '',
      excelStatus: task?.excel?.status || '',
      archiveStatus: task?.archive?.status || '',
      taskId: task?.taskId || '',
      updatedAt: task?.updatedAt || '',
    };
  });
  const gate = archiveGateForSharedPackage({ packageId, requiredPlatforms });
  return {
    mode: 'archive-gate-preview',
    readOnly: true,
    packageId,
    requiredPlatforms,
    gate,
    notice: '只读归档门槛预览：未复制、未移动、未删除任何文件。草稿或模拟完成不等于正式发布；只有所有要求平台人工确认正式发布后，后续阶段才可进入归档确认。',
  };
}

const COMMANDS = {
  getConfig: cmdGetConfig, setConfig: cmdSetConfig, scan: cmdScan, getPackage: cmdGetPackage,
  prepareOfficialTask: cmdPrepareOfficialTask, simulateOfficialTask: cmdSimulateOfficialTask,
  getTasks: cmdGetTasks, getTask: cmdGetTask, removeTask: cmdRemoveTask,
  confirmPublishedSimulated: cmdConfirmPublishedSimulated,
  confirmExcelRegisteredSimulated: cmdConfirmExcelRegisteredSimulated,
  confirmArchivedSimulated: cmdConfirmArchivedSimulated,
  previewExcelRegistration: cmdPreviewExcelRegistration,
  getCapabilities: cmdGetCapabilities, checkRealActionGate: cmdCheckRealActionGate,
  preflightPackage: cmdPreflightPackage,
  generateRealExecutionChecklist: cmdGenerateRealExecutionChecklist,
  getShareableConfigTemplate: cmdGetShareableConfigTemplate,
  importShareableConfigTemplate: cmdImportShareableConfigTemplate,
  previewArchiveGate: cmdPreviewArchiveGate,
  prepareZhihuDraft: cmdPrepareZhihuDraft,
  beginZhihuDraft: cmdBeginZhihuDraft,
  advanceZhihuDraft: cmdAdvanceZhihuDraft,
  completeZhihuDraft: cmdCompleteZhihuDraft,
  failZhihuDraft: cmdFailZhihuDraft,
};
const commandRouter = createCommandRouter(COMMANDS);

async function bindOrVerifyOrigin(origin) {
  if (STATE.trustedOrigin && STATE.trustedOrigin !== origin) return false;
  if (!STATE.trustedOrigin) {
    // Possession of the manually transferred token is the pairing proof.  The
    // first authenticated extension origin is persisted; other extensions can
    // no longer reuse the service even if they can reach localhost.
    STATE.trustedOrigin = origin;
    const config = await loadConfig();
    await saveConfig({
      version: config.version || 2,
      roots: config.roots || { unpublished: '', published: '', archive: '' },
      excel: config.excel || { planPath: '', sheetName: '' },
      mappings: config.mappings || { platformValues: DEFAULT_PLATFORM_VALUES },
      captionPolicy: config.captionPolicy || DEFAULT_CAPTION_POLICY,
      security: { ...(config.security || {}), trustedOrigin: origin },
    });
  }
  return true;
}

const server = createLocalApiServer({
  port: PORT,
  version: VERSION,
  protocol: PROTOCOL,
  build: ACCEPTANCE_BUILD,
  maxBodyBytes: MAX_BODY_BYTES,
  commandRouter,
  getToken: () => STATE.token,
  bindOrVerifyOrigin,
});

const STATE = {};

export async function startApplication() {
  const { token, created } = await loadOrCreateToken();
  STATE.token = token;
  const config = await loadConfig();
  STATE.trustedOrigin = /^chrome-extension:\/\/[a-p]{32}$/i.test(config.security?.trustedOrigin || '')
    ? config.security.trustedOrigin
    : '';
  // 阶段1B~1D：任务/站点锁目录就绪，并把上次中断的中间态任务标记为「结果待核对（重启中断）」
  await fs.mkdir(TASK_DIR, { recursive: true });
  await fs.mkdir(LOCK_DIR, { recursive: true });
  const recovered = await store.recoverInterrupted();
  if (recovered) console.log(`重启恢复：${recovered} 个中断任务已标记「结果待核对（重启中断）」，未自动重发。`);
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`易造发布助手 · 本地服务 v${VERSION}`);
    console.log(`监听：http://127.0.0.1:${PORT}（仅回环地址）`);
    if (created) {
      console.log('\n首次配对令牌（已写入 data/token，请复制粘贴到插件工作台，不要通过聊天/网络传输）：\n');
      console.log(`  ${token}\n`);
    } else if (process.argv.includes('--print-token')) {
      console.log(`配对令牌：${token}`);
    } else {
      console.log('令牌已存在（如需查看：node server.mjs --print-token）');
    }
    console.log('白名单命令（25 条）：原有 20 条只读/模拟命令；Stage 3 新增 prepare/begin/advance/complete/failZhihuDraft（仅知乎保存草稿）。');
    console.log('包↔平台绑定：prepare/simulate 只允许把包发往其受控目录推导出的站点，不匹配直接拒绝。');
    console.log('Stage 3：仅受保护的知乎单篇 saveDraft 可在用户当次确认、快照复核与登录检查后执行；公开 publish 始终拒绝。');
    console.log('不提供公开发布/Excel 写入登记/真实归档命令，不启动旧执行器，不修改文章与 Excel。');
    console.log('站点锁作用域：仅在新服务遵循同一文件锁协议的进程之间互斥，不覆盖未接入本协议的旧执行器。');
  });
}
