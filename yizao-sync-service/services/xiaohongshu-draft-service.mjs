import { TASK_STATUS } from '../domain/status.mjs';
import { makeTaskKey } from '../lib/snapshot.mjs';
import { checkRealActionGate } from '../lib/capabilities.mjs';

const ACCOUNT_ID = 'xiaohongshu-current-session';
const MODE = 'xiaohongshu-draft';
const PROGRESS = new Set([TASK_STATUS.UPLOADING, TASK_STATUS.FILLING, TASK_STATUS.SAVING_DRAFT]);
const REQUIRED_CHECKS = new Set([
  'title', 'body-text', 'image-count', 'draft-indexeddb',
  'trusted-draft-url', 'draft-only', 'read-back-verified',
]);

function snapshotRecord(snapshot) {
  return {
    articleId: snapshot.source.packageId, packageId: snapshot.source.packageId,
    title: snapshot.content.title, contentHash: snapshot.source.contentVersion,
    images: snapshot.assets.map(({ name, sha256, bytes }) => ({ name, sha256, bytes })),
    occurrences: snapshot.occurrences.map((item) => ({
      position: item.position, assetName: item.assetName, sha256: item.sha256,
      alt: item.effectiveAlt, caption: item.caption,
    })),
    target: 'xiaohongshu', createdAt: snapshot.createdAt,
  };
}

function assertSameSnapshot(task, current) {
  if (task.snapshotId !== current.snapshotId || task.contentVersion !== current.source.contentVersion) {
    throw new Error('源文章包在任务创建后发生变化，已停止保存草稿；请重新扫描并创建新任务');
  }
}

function sanitizeFidelityReport(report) {
  if (!report || report.schema !== 'yizao-html-fidelity-report' || !report.summary || !Array.isArray(report.checks)) return null;
  const statuses = new Set(['PASS', 'DEGRADED', 'UNSUPPORTED', 'FAIL']);
  return {
    overall: statuses.has(report.overall) ? report.overall : 'FAIL',
    fidelityVerified: report.fidelityVerified === true,
    summary: {
      pass: Number(report.summary.pass) || 0, degraded: Number(report.summary.degraded) || 0,
      unsupported: Number(report.summary.unsupported) || 0, fail: Number(report.summary.fail) || 0,
    },
    checks: report.checks.slice(0, 32).map((check) => ({
      key: String(check?.key || '').slice(0, 80),
      status: statuses.has(check?.status) ? check.status : 'FAIL',
      required: check?.required === true,
      detail: String(check?.detail || '').slice(0, 240),
    })),
  };
}

function safeDraftResult(result = {}) {
  const postId = String(result.postId || '').trim();
  if (postId.length < 3 || postId.length > 300 || !/^(?:s|n|b|j):[^\r\n\u0000-\u001f]+$/.test(postId)) {
    throw new Error('小红书草稿回读结果缺少有效的本地草稿键');
  }
  let url;
  try { url = new URL(String(result.postUrl || '')); } catch { throw new Error('小红书草稿回读结果缺少有效草稿 URL'); }
  if (url.protocol !== 'https:' || url.hostname !== 'creator.xiaohongshu.com'
      || url.pathname !== '/publish/publish' || url.searchParams.get('target') !== 'image') {
    throw new Error('小红书草稿 URL 不受信任');
  }
  if (result.success !== true || result.draftOnly !== true || result.readBackVerified !== true || result.fidelityVerified !== true) {
    throw new Error('小红书草稿未通过保存后回读校验，不能标记 draft_saved');
  }
  const fidelity = sanitizeFidelityReport(result.fidelityReport);
  if (!fidelity || fidelity.fidelityVerified !== true || fidelity.checks.some((check) => check.required && check.status !== 'PASS')) {
    throw new Error('小红书草稿保真报告缺失或必需检查未通过，不能标记 draft_saved');
  }
  const byKey = new Map(fidelity.checks.map((check) => [check.key, check]));
  for (const key of REQUIRED_CHECKS) {
    const check = byKey.get(key);
    if (!check || !check.required || check.status !== 'PASS') throw new Error(`小红书草稿保真报告缺少必需 PASS：${key}`);
  }
  return { postId, postUrl: url.toString(), readBackVerified: true, fidelityVerified: true, fidelity, savedAt: new Date().toISOString() };
}

export class XiaohongshuDraftService {
  constructor({ store, loadSnapshot }) { this.store = store; this.loadSnapshot = loadSnapshot; }

  async prepare({ packageId, userConfirmed }) {
    if (userConfirmed !== true) throw new Error('保存小红书草稿需要用户在当前操作中明确确认');
    const context = await this.loadSnapshot(packageId);
    const { snapshot } = context;
    if (!snapshot.gate.executable) return { started: false, reason: 'snapshot-blocked', gate: snapshot.gate };
    const taskKey = makeTaskKey({ packageId, platform: 'xiaohongshu', accountId: ACCOUNT_ID, contentVersion: snapshot.source.contentVersion });
    const created = await this.store.createTask({
      taskKey, packageId, rootName: context.rootName, relativePath: context.relativePath,
      platform: 'xiaohongshu', platformName: '小红书', accountId: ACCOUNT_ID,
      accountLabel: '当前 Chrome 小红书会话', contentVersion: snapshot.source.contentVersion,
      title: snapshot.content.title, segments: context.segments, snapshotId: snapshot.snapshotId,
      snapshot: snapshotRecord(snapshot), mode: MODE,
    });
    if (!created.created) return { started: false, reason: created.reason, task: created.task, busy: created.busy };
    await this.store.transitionStatus(created.task.taskId, TASK_STATUS.VALIDATING, '服务端复核发布包与不可变快照');
    const task = await this.store.transitionStatus(created.task.taskId, TASK_STATUS.READY, '快照已锁定，等待扩展检查当前小红书登录会话');
    return { started: true, task, gate: snapshot.gate };
  }

  async begin({ taskId, snapshotId, userConfirmed }) {
    const task = await this.store.getTask(taskId);
    if (!task || task.mode !== MODE) throw new Error('找不到小红书草稿任务');
    if (task.status !== TASK_STATUS.READY) throw new Error(`任务当前状态 ${task.status}，不能重复开始`);
    if (snapshotId !== task.snapshotId) throw new Error('snapshotId 与任务不匹配');
    const current = await this.loadSnapshot(task.packageId);
    try { assertSameSnapshot(task, current.snapshot); }
    catch (error) { await this.store.transitionStatus(taskId, TASK_STATUS.FAILED, error.message); throw error; }
    const gate = checkRealActionGate({ action: 'saveDraft', platform: 'xiaohongshu', authorization: {
      stage: '7-xiaohongshu-draft', userConfirmed, snapshotVerified: true,
    } });
    if (!gate.allowed) throw new Error(gate.reason);
    const running = await this.store.transitionStatus(taskId, TASK_STATUS.RUNNING, '安全闸门已通过；仅允许保存小红书草稿');
    return { task: running, authorization: { action: 'saveDraft', platform: 'xiaohongshu', snapshotId: task.snapshotId } };
  }

  async progress({ taskId, status, detail = '' }) {
    if (!PROGRESS.has(status)) throw new Error('不允许的小红书草稿进度状态');
    const task = await this.store.getTask(taskId);
    if (!task || task.mode !== MODE) throw new Error('找不到小红书草稿任务');
    return this.store.transitionStatus(taskId, status, String(detail).slice(0, 300));
  }

  async complete({ taskId, result }) {
    const task = await this.store.getTask(taskId);
    if (!task || task.mode !== MODE) throw new Error('找不到小红书草稿任务');
    const current = await this.loadSnapshot(task.packageId);
    try { assertSameSnapshot(task, current.snapshot); }
    catch (error) { await this.store.transitionStatus(taskId, TASK_STATUS.FAILED, error.message); throw error; }
    const draftResult = safeDraftResult(result);
    await this.store.transitionStatus(taskId, TASK_STATUS.DRAFT_SAVED, '小红书草稿已保存并通过本地草稿库回读校验', { draftResult });
    return this.store.transitionStatus(taskId, TASK_STATUS.WAITING_CONFIRMATION, '草稿已保存；等待用户打开检查，绝不自动公开发布');
  }

  async fail({ taskId, error, fidelityReport }) {
    const task = await this.store.getTask(taskId);
    if (!task || task.mode !== MODE) throw new Error('找不到小红书草稿任务');
    if ([TASK_STATUS.WAITING_CONFIRMATION, TASK_STATUS.FAILED, TASK_STATUS.CANCELLED].includes(task.status)) return task;
    const fidelityFailure = sanitizeFidelityReport(fidelityReport);
    return this.store.transitionStatus(taskId, TASK_STATUS.FAILED, String(error || '小红书草稿保存失败').slice(0, 500), fidelityFailure ? { fidelityFailure } : {});
  }
}
