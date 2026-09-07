import { makeTaskKey } from './snapshot.mjs';
import { CrossProcessLock } from './mutex.mjs';

/**
 * 官网 / 百家号原流程接入骨架（阶段1B）。
 *
 * 依据旧助手的实际契约（只读参考，不复制执行逻辑）：
 * - 官网 CMS：admin.eyzao.com(EmCms)、www.eyzao.cn / www.yzfanglei.com(FHRLCMS)，
 *   按 SEO「内容栏目」经 site.categoryMapping 选 CMS 栏目；正文 + 图片（按出现顺序，
 *   写原生 ALT，不改 src）填进后台后停在「待人工 / 等待手动立即提交」；
 * - 百家号：浏览器全自动填稿（标题、正文导入、逐图描述 ≤18 字、AI 声明、营销电话），
 *   最终「发布」按钮永远由人来点（adapterBaijia.autoPublishes = false）；
 * - 站点锁按 siteKey 互斥：旧助手 SITE_LOCKS 是同一进程内 per-site 的 Map，
 *   与本服务使用的文件锁并不是同一个协议。
 *
 * 【审查返工 P0-2 · 锁的作用域必须写准】
 * 本服务的跨进程文件锁（lib/mutex.mjs）只在「同样遵循本协议的新服务进程」之间生效。
 * 旧助手（C:\Users\Future\Desktop\自动化发布）当前既未接入该文件锁，本轮也不允许修改它，
 * 因此本轮只能验证「新服务的多个模拟执行器进程之间互斥」，
 * 不能声称、也不能据此推断与旧执行器互斥。真实阶段开始前必须另行设计并验收新旧执行器的
 * 协调策略；端口不同更不能保证 Chrome 登录资料目录隔离。
 *
 * 阶段1B 命令只允许：
 * - prepareOfficialTask：只生成执行预览 + 不可变发送快照（不创建任务、不启动执行器）；
 * - simulateOfficialTask：只走模拟状态机，终态「等待用户最终提交（模拟）」，绝不点击最终发布。
 * 真实执行命令不进入命令白名单；本模块没有把正文发往平台的代码路径。
 *
 * 本表是模拟用“站点/栏目映射占位”，仅用于预览可读性；真实授权后必须改用可审计的站点配置，
 * 不能把本表当作线上栏目映射的最终事实。
 */
export const SITE_REGISTRY = [
  {
    siteKey: 'eyzao.com', name: '官网 · EmCms', adapter: 'emcms', admin: '(占位) admin.eyzao.com',
    domains: ['www.eyzao.com', 'eyzao.com'], kind: 'official',
    categoryMapping: { '浪涌保护器': '浪涌保护器', '易造新闻': '易造新闻' }, categoryFallback: '常见问题',
  },
  {
    siteKey: 'eyzao.cn', name: '官网 · FHRLCMS', adapter: 'fhrlcms', admin: '(占位) www.eyzao.cn/fhrl-admin.php',
    domains: ['www.eyzao.cn', 'eyzao.cn'], kind: 'official',
    categoryMapping: { '智能雷暴仪': '智能雷暴仪', '雷电预警系统': '雷电预警系统', '易造新闻': '易造新闻' }, categoryFallback: '常见问题',
  },
  {
    siteKey: 'yzfanglei.com', name: '官网 · FHRLCMS', adapter: 'fhrlcms', admin: '(占位) www.yzfanglei.com/fhrl-admin.php',
    domains: ['www.yzfanglei.com', 'yzfanglei.com'], kind: 'official',
    categoryMapping: { '智能防雷系统': '智能防雷系统', '易造新闻': '易造新闻' }, categoryFallback: '常见问题',
  },
  {
    siteKey: 'baijiahao', name: '百家号', adapter: 'Baijia', kind: 'baijiahao',
    domains: ['百家号', 'baijiahao', 'baijia'], categoryMapping: {}, categoryFallback: '',
    platformLabel: '百家号',
  },
];

/** 站点键集合（命令 platform 参数白名单）。 */
export const SITE_KEYS = SITE_REGISTRY.map((s) => s.siteKey);
export function siteMeta(siteKey) { return SITE_REGISTRY.find((s) => s.siteKey === siteKey); }
export function siteMetaForDomain(domain) {
  const d = String(domain || '').trim();
  return SITE_REGISTRY.find((s) => s.domains.includes(d.toLowerCase())) || null;
}
/**
 * 【审查返工 P0-1】发布包允许的目标站点：只能由服务端根据扫描索引里包的
 * 受控相对路径推导，绝不接受客户端声称的平台。
 *
 * 目录惯例（与只读扫描的 segments 一致）：
 * - 官网：<官网|website>/<域名>/<栏目>/<日期>/<包>，域名段决定唯一站点键；
 * - 主流平台：<主流平台|mainstream>/<百家号|baijiahao>/...，平台段决定站点键。
 *
 * 推导不出（未知域名 / 目录惯例不符 / 官网段下出现非官网站点）→ allowed 为空，
 * 由命令层拒绝并给出人工处理提示，绝不回退到“相信客户端传入的 siteKey”。
 *
 * @param {string[]} segments 包在授权根目录下的受控相对路径分段
 * @returns {{ siteKeys:string[], reason:string, kindSegment:string, sourceSegment:string }}
 */
export const OFFICIAL_KIND_SEGMENTS = new Set(['官网', 'website', '官网站点']);
export const MAINSTREAM_KIND_SEGMENTS = new Set(['主流平台', 'mainstream', 'platform', '平台']);

export function allowedSiteKeysForSegments(segments) {
  const segs = (Array.isArray(segments) ? segments : []).map((s) => String(s || '').trim()).filter(Boolean);
  const [kindSegment = '', sourceSegment = ''] = segs;
  const out = { siteKeys: [], reason: '', kindSegment, sourceSegment };
  if (segs.length === 0) { out.reason = 'empty-path'; return out; }

  if (OFFICIAL_KIND_SEGMENTS.has(kindSegment)) {
    const meta = siteMetaForDomain(sourceSegment);
    if (!meta) { out.reason = `官网包缺少可识别的域名段（第 2 段为「${sourceSegment}」）`; return out; }
    if (meta.kind !== 'official') { out.reason = `官网目录下出现了非官网站点段「${sourceSegment}」`; return out; }
    out.siteKeys = [meta.siteKey];
    out.reason = 'ok';
    return out;
  }

  if (MAINSTREAM_KIND_SEGMENTS.has(kindSegment)) {
    // 平台包：在后续分段里找已接入的非官网站点（当前只有百家号）；
    // 出现官网域名 → 目录惯例与站点类型冲突，宁可拒绝也不猜。
    const found = [];
    for (const seg of segs.slice(1)) {
      const meta = siteMetaForDomain(seg);
      if (!meta) continue;
      if (meta.kind === 'official') { out.reason = `平台目录下出现了官网域名段「${seg}」，目录与站点类型冲突`; return out; }
      if (!found.includes(meta.siteKey)) found.push(meta.siteKey);
    }
    if (found.length === 1) { out.siteKeys = found; out.reason = 'ok'; return out; }
    if (found.length > 1) { out.reason = `平台目录下出现多个站点段（${found.join(', ')}）`; return out; }
    out.reason = `平台包缺少可识别的平台段（目录：${segs.join('/')}）`;
    return out;
  }

  out.reason = `无法从目录推导目标平台（首段为「${kindSegment}」，需要「官网」或「主流平台」）`;
  return out;
}

/** 向后兼容：返回推导出的唯一站点键，推导不出返回空串（命令层不得据此放行）。 */
export function siteKeyFromSegments(segments) {
  const { siteKeys } = allowedSiteKeysForSegments(segments);
  return siteKeys.length === 1 ? siteKeys[0] : '';
}

/**
 * 命令层强制绑定校验：包与站点不匹配时抛出，调用方不得再生成预览或创建任务。
 * @param {{packageId?:string, relativePath?:string, siteKey?:string}} args
 */
export function assertPackageSiteBinding({ packageId, relativePath, siteKey }) {
  const segments = String(relativePath || '').split('/').filter(Boolean);
  const allowed = allowedSiteKeysForSegments(segments);
  if (allowed.siteKeys.length === 0) {
    throw new Error(`无法从该包的受控目录推导目标平台（${allowed.reason}）。已拒绝，未生成预览/任务；请调整目录后重新扫描。`);
  }
  if (!allowed.siteKeys.includes(siteKey)) {
    throw new Error(`发布包与目标平台不匹配：该包位于「${segments.join('/')}」，仅允许 ${allowed.siteKeys.join('/')}；收到 siteKey=${siteKey}。已拒绝，未生成预览、未创建任务。`);
  }
  return { segments, allowedSiteKeys: allowed.siteKeys, packageId };
}

/** 账号占位（阶段1B 不读取、不登录任何真实账号）。 */
export function placeholderAccountLabel(siteKey) {
  const meta = siteMeta(siteKey);
  return meta ? `${meta.name} 账号（占位 · 需要另行授权真实账号）` : '占位账号';
}

/** 未来真实执行器的步骤契约（只读描述；1B 不执行任何真实动作）。 */
export function publishFlowSpec(siteKey, { categoryLabel, accountLabel, occurrenceCount }) {
  const meta = siteMeta(siteKey);
  const kind = meta?.kind || 'official';
  const cms = kind === 'baijiahao' ? '百家号后台' : `${meta?.name} 后台`;
  const cmsCategory = categoryLabel || meta?.categoryFallback || '（待映射栏目）';
  return [
    { step: 'validate', label: `校验发送快照与「包↔平台」绑定（包目录推导出的站点必须等于 ${siteKey}；缺图/同名/ALT 冲突/图片读取失败会阻止进入可执行状态）` },
    { step: 'lock', label: `获取跨进程站点锁 site-${siteKey}（仅在遵循同一锁协议的新服务进程之间互斥；未接入本协议的旧执行器不受此锁约束）` },
    { step: 'resolveColumns', label: `解析 ${cms} 栏目/分类 → ${cmsCategory}；SEO 字段取 SEO 标题/关键字/描述` },
    { step: 'fillSeo', label: `填写标题/SEO（${accountLabel}）——模拟填写，不打开真实后台` },
    { step: 'fillBody', label: `按正文出现顺序填充正文与 ${occurrenceCount} 处图片（写原生 ALT；官网/百家号不追加可见图注）` },
    { step: 'stop', label: `停在「等待用户最终提交」——由用户人工核对并在浏览器点击最终提交/发布；本流程绝不自动点击` },
  ];
}

/**
 * 站点锁键。
 * 作用域说明（审查返工 P0-2）：这把锁只约束「同样使用 lib/mutex.mjs 文件锁协议的新服务
 * 进程」。旧助手未接入本协议，本轮也不允许修改它，因此本锁**不等于**与旧执行器互斥。
 */
export function siteLockKey(siteKey) { return `site-${siteKey}`; }

/** 栏目解析预览（真实授权后用站点配置读取；这里按 SEO 内容栏目映射并标注为占位）。 */
export function previewCategory(siteKey, seoCategory) {
  const meta = siteMeta(siteKey);
  const mapped = (meta && seoCategory) ? (meta.categoryMapping[seoCategory] || meta.categoryFallback || '') : '';
  return {
    seoCategory: seoCategory || '',
    cmsCategory: mapped,
    note: meta?.categoryMapping ? '栏目映射为模拟占位表，真实授权后须以可审计站点配置为准。' : '需要另行授权读取站点栏目配置。',
  };
}

/** 生成执行预览（不含正文副本；图片只列摘要 + SHA-256）。 */
export function buildPublishPreview({ snapshot, siteKey }) {
  const meta = siteMeta(siteKey);
  const accountLabel = placeholderAccountLabel(siteKey);
  const category = previewCategory(siteKey, snapshot.content.seoCategory);
  const spec = publishFlowSpec(siteKey, {
    categoryLabel: category.cmsCategory,
    accountLabel,
    occurrenceCount: snapshot.occurrences.length,
  });
  return {
    mode: 'preview',
    simulatedOnly: true,
    siteKey,
    siteName: meta?.name || siteKey,
    platform: meta?.kind === 'baijiahao' ? 'baijiahao' : 'official',
    platformName: meta?.kind === 'baijiahao' ? '百家号' : '官网',
    adapter: meta?.adapter || '',
    account: accountLabel,
    accountId: placeholderAccountFor(siteKey),
    lockKey: siteLockKey(siteKey),
    note: '仅执行预览：未创建任务、未启动执行器、未打开浏览器、未点击最终发布。',
    gate: snapshot.gate,
    contentVersion: snapshot.source.contentVersion,
    contentVersionShort: snapshot.source.contentVersion.slice(0, 12),
    content: { title: snapshot.content.title, imageCount: snapshot.content.imageCount, seoCategory: snapshot.content.seoCategory },
    category,
    assets: snapshot.assets.map((a) => ({ dir: a.dir, name: a.name, sha256: a.sha256, bytes: a.bytes })),
    // 每个出现位置的 ALT/图注决策（两个字段始终分开；无既有图注时绝不生成/追加）
    occurrences: snapshot.occurrences.map((o) => ({
      position: o.position,
      name: o.name,
      asset: o.assetDir && o.assetName ? `${o.assetDir}/${o.assetName}` : '',
      alt: o.effectiveAlt,
      altSource: o.altSource,
      altConflict: o.altConflict,
      caption: o.caption,
      captionSource: o.captionSource,
      captionAppended: false,
    })),
    flow: spec,
    finalAction: '等待用户最终提交（模拟）——绝不自动发布',
    previewOnly: true,
  };
}

function placeholderAccountFor(siteKey) {
  const meta = siteMeta(siteKey);
  return `${meta ? meta.siteKey : 'site'}-占位账号`;
}

/** 命令层的站点/账号白名单校验。 */
export function validSiteKey(v) { return SITE_KEYS.includes(v); }
export function validPublishAccount(siteKey, accountId) {
  return accountId === placeholderAccountFor(siteKey);
}

const acquiredLocks = new Set(); // 本进程内已持有的站点锁（避免同进程重复拿同一把锁）

/**
 * 运行官网/百家号模拟状态机：幂等创建任务，先获取跨进程站点锁，
 * 后台分步推进，终态「等待用户最终提交（模拟）」后释放锁。
 * 绝不自动重发、绝不把请求发往真实平台。
 *
 * 锁的作用域（审查返工 P0-2）：此处只保证「多个遵循同一文件锁协议的新服务模拟执行器」
 * 之间不并发写同一站点；与未接入该协议的旧执行器之间没有经过验证的互斥关系。
 *
 * 入参约束（审查返工 P0-1）：调用方（server.mjs）必须先用
 * assertPackageSiteBinding() 校验包目录推导出的站点等于 siteKey，才允许进入本函数。
 *
 * @param {object} args
 * @param {TaskStore} args.store
 * @param {object} args.snapshot   buildSendSnapshot() 产物
 * @param {string} args.siteKey    eyzao.com / eyzao.cn / yzfanglei.com / baijiahao
 * @param {string} args.lockDir    锁文件目录（服务 data/locks）
 */
export async function startSimulatedPublish({ store, snapshot, siteKey, lockDir }) {
  const meta = siteMeta(siteKey);
  if (!meta) return { created: false, reason: 'unknown-site', started: false };
  if (!snapshot.gate.executable) {
    return { created: false, reason: 'gate-blocked', started: false, blocks: snapshot.gate.blocks };
  }

  const accountId = placeholderAccountFor(siteKey);
  const taskKey = makeTaskKey({
    packageId: snapshot.source.packageId,
    platform: siteKey,
    accountId,
    contentVersion: snapshot.source.contentVersion,
  });

  // 幂等优先（只读查键，不依赖站点锁）：先确认同键任务是否已存在，
  // 命中就直接返回 exists/stalled。这样「终态已写入、锁还没释放完」的时间窗
  // 不会把 exists 误报成 site-lock-busy，也绝不会重跑已核对过的内容。
  const existing = await store.findByTaskKey(taskKey);
  if (existing) {
    const reason = existing.states?.draft?.stage === '结果待核对（重启中断）' ? 'stalled' : 'exists';
    return { created: false, started: false, reason, task: existing };
  }

  // 再真正尝试拿站点锁（在创建任务之前）：锁被占用 → 不创建任务，直接返回忙碌，
  // 避免留下一个「失败」任务永久占住任务键而无法重试。
  // 注意：这把锁只在本服务遵循同一文件锁协议的进程之间生效（见 siteLockKey 注释）。
  const lock = new CrossProcessLock(lockDir, siteLockKey(siteKey));
  let lockOk = false;
  if (!acquiredLocks.has(siteLockKey(siteKey))) {
    try { lockOk = await lock.acquire(`sim-${process.pid}`); } catch { lockOk = false; }
  }
  if (!lockOk) {
    return {
      created: false, started: false, reason: 'site-lock-busy',
      detail: `站点锁 ${siteLockKey(siteKey)} 被占用：另一个遵循同一锁协议的新服务进程正在处理该站点。已停止模拟，请稍后重试；本流程绝不并发写同一站点。（该锁不覆盖未接入本协议的旧执行器。）`,
    };
  }
  acquiredLocks.add(siteLockKey(siteKey));
  const release = async () => {
    try { await lock.release(); } catch { /* 尽力释放 */ }
    acquiredLocks.delete(siteLockKey(siteKey));
  };

  const segments = String(snapshot.source.relativePath || '').split('/').filter(Boolean);
  const result = await store.createTask({
    taskKey,
    packageId: snapshot.source.packageId,
    rootName: snapshot.source.rootName,
    relativePath: snapshot.source.relativePath,
    platform: siteKey,
    platformName: meta.name,
    platformKind: meta.kind,
    accountId,
    accountLabel: placeholderAccountLabel(siteKey),
    contentVersion: snapshot.source.contentVersion,
    contentVersionShort: snapshot.source.contentVersion.slice(0, 12),
    title: snapshot.content.title || snapshot.source.relativePath,
    segments,
    snapshotId: snapshot.snapshotId,
    mode: 'simulate',
  });
  if (!result.created) {
    await release();
    return { created: false, reason: result.reason, busy: result.busy, task: result.task, started: false };
  }

  const taskId = result.task.taskId;

  const steps = [
    { stage: '校验发送快照', detail: '模拟校验已完成，发送快照可执行。', delay: 120 },
    { stage: '获取站点锁（模拟）', detail: `模拟：已获取跨进程站点锁 ${siteLockKey(siteKey)}（仅在新服务进程之间互斥，不覆盖未接入本协议的旧执行器）；未启动旧执行器、未占用登录资料。`, delay: 420 },
    { stage: '模拟填写后台', detail: `${meta.name}：模拟填写栏目/SEO/正文与图片（按出现顺序、写原生 ALT；不追加可见图注；不点击最终提交）。`, delay: 520 },
  ];

  // 后台分步推进：每步先原子持久化，再延迟；进程关闭时任务停留在当前中间状态，
  // 重启后由 recoverInterrupted 标记「结果待核对（重启中断）」，绝不自动重发。
  let i = 0;
  const schedule = () => {
    if (i >= steps.length) {
      store.finishTask(taskId, '等待用户最终提交（模拟）',
        `模拟已停在「等待用户最终提交」。真实执行需单独授权：届时由用户在浏览器人工核对并点击最终提交/发布，本服务不会自动点击。未上传、未发布、未登记 Excel、未归档。`)
        .then(release)
        .catch(() => release());
      return;
    }
    const step = steps[i];
    i += 1;
    setTimeout(async () => {
      try {
        await store.updateStage(taskId, step.stage, step.detail);
        schedule();
      } catch {
        // 任务存储写失败（磁盘异常/服务关闭）：释放锁并标记失败，保留已完成副本。
        await store.setFailure(taskId, `模拟中断（${step.stage} 写状态失败）。不会自动重发；源文件不受影响。`).catch(() => {});
        await release();
      }
    }, step.delay);
  };
  schedule();
  return { created: true, taskId, started: true, task: result.task };
}

export { CrossProcessLock, makeTaskKey };
