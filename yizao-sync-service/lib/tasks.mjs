import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { TASK_STATUS, assertTaskStatusTransition } from '../domain/status.mjs';

/**
 * 任务状态与幂等存储（阶段1B 本地 JSON 原型）。
 *
 * 设计（对应任务书 P0：任务状态、幂等与恢复）：
 * - 稳定任务键 = packageId + platform + accountId + contentVersion；
 * - 草稿/平台状态、正式发布状态、Excel 登记状态、归档状态分开保存，互不联动；
 * - 每次变更原子写（临时文件 + rename），文件带 schema 版本，服务重启可迁移/重读；
 * - 中途状态（正在跑的任务）在重启后被标记为「结果待核对（重启中断）」，绝不自动重发；
 * - 同一账号同一时间只允许一个进行中的写任务；双击不会创建重复任务；
 * - 不保存令牌、Cookie、正文副本——只保存标题、路径、哈希与状态/操作日志。
 */

export const INTERMEDIATE = new Set(['校验中', '模拟填写后台', '模拟等待用户最终提交', '模拟提交草稿']);
export const TERMINAL = new Set(['等待用户最终提交（模拟）', '模拟完成（未保存草稿）', '失败', '已核对已清除（模拟）']);
const atomicWriteQueues = new Map();

function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function writeJsonAtomicNow(file, obj) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    await fs.writeFile(tmp, JSON.stringify(obj, null, 2), { encoding: 'utf8', flag: 'wx' });
    for (let attempt = 0; ; attempt += 1) {
      try {
        await fs.rename(tmp, file);
        return;
      } catch (error) {
        const transient = ['EPERM', 'EACCES', 'EBUSY'].includes(error?.code);
        if (!transient || attempt >= 5) throw error;
        await wait(20 * (2 ** attempt));
      }
    }
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => {});
  }
}

/** 原子写 JSON（Windows 上先写临时文件再 rename，避免半截文件）。 */
export function writeJsonAtomic(file, obj) {
  const previous = atomicWriteQueues.get(file) || Promise.resolve();
  const current = previous.catch(() => {}).then(() => writeJsonAtomicNow(file, obj));
  atomicWriteQueues.set(file, current);
  return current.finally(() => {
    if (atomicWriteQueues.get(file) === current) atomicWriteQueues.delete(file);
  });
}

function stageTime() { return new Date().toISOString(); }
function shortHash(h) { return String(h || '').slice(0, 12); }

export function makeId(prefix) {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

export function initialState() {
  const now = stageTime();
  return {
    draft: { stage: '未执行', detail: '', updatedAt: now },
    publish: { status: '未发布', detail: '模拟：未调用任何真实发布动作', updatedAt: now },
    excel: { status: '未登记', detail: '阶段1B 不提供 Excel 写入命令', updatedAt: now },
    archive: { status: '未归档', detail: '阶段1B 不提供真实归档命令', updatedAt: now },
  };
}

/** 任务记录（不含正文、令牌、Cookie）。 */
export function newTask({ taskKey, packageId, rootName, relativePath, platform, platformName, accountId, accountLabel, contentVersion, contentVersionShort, title, segments, snapshotId, snapshot = null, mode = 'simulate' }) {
  const now = stageTime();
  return {
    schema: 2,
    taskId: makeId('tsk'),
    taskKey,
    mode,
    packageId,
    rootName,
    relativePath,
    platform,
    platformName,
    accountId,
    accountLabel,
    contentVersion,
    contentVersionShort: contentVersionShort || shortHash(contentVersion),
    title,
    segments,
    snapshotId,
    snapshot,
    status: TASK_STATUS.PENDING,
    runState: 'active', // active | terminal | stalled
    states: initialState(),
    history: [],
    createdAt: now,
    updatedAt: now,
    finishedAt: '',
  };
}

export class TaskStore {
  /** @param {string} taskDir 任务 JSON 目录（测试用系统临时目录） */
  constructor(taskDir) {
    this.taskDir = taskDir;
  }

  _file(taskId) { return path.join(this.taskDir, `${this._safeId(taskId)}.json`); }
  _safeId(id) { return String(id).replace(/[^a-zA-Z0-9_-]/g, '_'); }

  async listTasks() {
    try {
      const names = await fs.readdir(this.taskDir);
      const tasks = [];
      for (const name of names) {
        if (!name.endsWith('.json') || name.includes('.tmp')) continue;
        try { tasks.push(JSON.parse(await fs.readFile(path.join(this.taskDir, name), 'utf8'))); } catch { /* 半截/损坏：忽略，不算正文副本 */ }
      }
      return tasks.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
    } catch { return []; }
  }

  async getTask(taskId) {
    try { return JSON.parse(await fs.readFile(this._file(taskId), 'utf8')); } catch { return null; }
  }

  async findByTaskKey(taskKey) {
    for (const t of await this.listTasks()) if (t.taskKey === taskKey) return t;
    return null;
  }

  /** 进行中写任务判定：创建后到明确结束前都算 active/stalled。 */
  _isBusy(task) {
    if (!task) return false;
    if (task.runState === 'terminal') return false;
    if (task.states?.draft?.stage === '失败') return false;
    return true;
  }

  async findBusyByAccount(accountId, excludeTaskId = '') {
    const list = await this.listTasks();
    return list.find((t) => t.accountId === accountId && t.taskId !== excludeTaskId && this._isBusy(t)) || null;
  }

  async saveTask(task) { await writeJsonAtomic(this._file(task.taskId), task); }

  /** 幂等创建：同键存在则返回既有；同账号有进行中写任务则拒绝。 */
  async createTask(input) {
    const existing = await this.findByTaskKey(input.taskKey);
    if (existing) return { created: false, task: existing, reason: existing.states?.draft?.stage === '结果待核对（重启中断）' ? 'stalled' : 'exists' };
    const busy = await this.findBusyByAccount(input.accountId);
    if (busy) return { created: false, task: null, reason: 'account-busy', busy };
    const task = newTask(input);
    await this.saveTask(task);
    return { created: true, task };
  }

  async updateStage(taskId, stage, detail) {
    const task = await this.getTask(taskId);
    if (!task) return null;
    const now = stageTime();
    task.states.draft = { stage, detail, updatedAt: now };
    task.history.push({ at: now, stage, detail: detail || '' });
    task.updatedAt = now;
    await this.saveTask(task);
    return task;
  }

  /** Stage 3 canonical transition. Illegal jumps are rejected and persisted tasks are never auto-retried. */
  async transitionStatus(taskId, nextStatus, detail = '', changes = {}) {
    const task = await this.getTask(taskId);
    if (!task) return null;
    const current = task.status || TASK_STATUS.PENDING;
    assertTaskStatusTransition(current, nextStatus);
    const now = stageTime();
    task.status = nextStatus;
    task.states.draft = { stage: nextStatus, detail: String(detail || ''), updatedAt: now };
    task.history.push({ at: now, stage: nextStatus, detail: String(detail || '') });
    Object.assign(task, changes);
    task.updatedAt = now;
    if ([TASK_STATUS.WAITING_CONFIRMATION, TASK_STATUS.FAILED, TASK_STATUS.CANCELLED].includes(nextStatus)) {
      task.runState = 'terminal';
      task.finishedAt = now;
    }
    await this.saveTask(task);
    return task;
  }

  /** 中间态任务全部标记为结果待核对；不自动重发、不复活。 */
  async recoverInterrupted() {
    const tasks = await this.listTasks();
    let changed = 0;
    for (const t of tasks) {
      if (this._isBusy(t) && t.states?.draft?.stage !== '结果待核对（重启中断）') {
        const now = stageTime();
        if (t.mode === 'zhihu-draft') {
          t.status = TASK_STATUS.FAILED;
          t.states.draft = { stage: TASK_STATUS.FAILED, detail: '任务执行时服务或扩展中断，结果未知。不会自动重发；请先在知乎草稿箱人工核对。', updatedAt: now };
          t.runState = 'stalled';
          t.history.push({ at: now, stage: TASK_STATUS.FAILED, detail: '重启恢复：结果未知，未自动重发' });
          t.updatedAt = now;
          await this.saveTask(t);
          changed += 1;
          continue;
        }
        t.states.draft = { stage: '结果待核对（重启中断）', detail: '任务正在执行时服务/扩展被中断，结果未确认。不会自动重发；请先人工核对，再决定清除或重新模拟。', updatedAt: now };
        t.runState = 'stalled';
        t.history.push({ at: now, stage: '结果待核对（重启中断）', detail: '重启恢复：自动标记，未自动重发' });
        t.updatedAt = now;
        await this.saveTask(t);
        changed += 1;
      }
    }
    return changed;
  }

  /** 标记完成（终态）。不会误伤源文件。 */
  async finishTask(taskId, stage, detail) {
    const task = await this.getTask(taskId);
    if (!task) return null;
    const now = stageTime();
    task.states.draft = { stage, detail: detail || '', updatedAt: now };
    task.history.push({ at: now, stage, detail: detail || '' });
    task.runState = 'terminal';
    task.finishedAt = now;
    task.updatedAt = now;
    await this.saveTask(task);
    return task;
  }

  async setFailure(taskId, detail) {
    const task = await this.getTask(taskId);
    if (!task) return null;
    const now = stageTime();
    task.states.draft = { stage: '失败', detail: detail || '模拟流程失败', updatedAt: now };
    task.history.push({ at: now, stage: '失败', detail: detail || '' });
    task.runState = 'terminal';
    task.finishedAt = now;
    task.updatedAt = now;
    await this.saveTask(task);
    return task;
  }

  /** 阶段2D：人工确认发布结果（模拟入口）。只改服务自身任务 JSON，不触碰平台、Excel 或文件。 */
  async confirmPublishedSimulated(taskId, { publicUrl = '', note = '' } = {}) {
    const task = await this.getTask(taskId);
    if (!task) return null;
    if (task.mode !== 'simulate') throw new Error('仅允许更新模拟任务');
    const now = stageTime();
    const link = String(publicUrl || '').trim();
    const extra = String(note || '').trim().slice(0, 200);
    task.states.publish = {
      status: '人工确认已发布',
      detail: `模拟人工确认：用户已在外部核对发布结果${link ? `，正式链接 ${link}` : ''}${extra ? `；备注：${extra}` : ''}。本服务未打开后台、未提交发布。`,
      publicUrl: link,
      updatedAt: now,
    };
    task.states.excel = {
      ...(task.states.excel || {}),
      status: task.states.excel?.status || '未登记',
      detail: task.states.excel?.detail || '仍未写入 Excel；后续需登记预览与单独授权。',
      updatedAt: task.states.excel?.updatedAt || now,
    };
    task.states.archive = {
      ...(task.states.archive || {}),
      status: task.states.archive?.status || '未归档',
      detail: task.states.archive?.detail || '仍未归档；需通过共享包归档门槛后单独授权。',
      updatedAt: task.states.archive?.updatedAt || now,
    };
    task.history.push({ at: now, stage: '人工确认已发布（模拟）', detail: task.states.publish.detail });
    task.updatedAt = now;
    await this.saveTask(task);
    return task;
  }

  /** 阶段2E：人工确认 Excel 登记（模拟入口）。只改服务自身任务 JSON，不写真实 Excel。 */
  async confirmExcelRegisteredSimulated(taskId, { sheetName = '', rowIndex = '', plTaskId = '', note = '' } = {}) {
    const task = await this.getTask(taskId);
    if (!task) return null;
    if (task.mode !== 'simulate') throw new Error('仅允许更新模拟任务');
    if (task.states?.publish?.status !== '人工确认已发布' && task.states?.publish?.status !== '已正式发布') {
      throw new Error('尚未人工确认正式发布，不能登记 Excel');
    }
    const now = stageTime();
    const sheet = String(sheetName || '').trim().slice(0, 80);
    const row = String(rowIndex || '').trim().slice(0, 20);
    const taskNo = String(plTaskId || '').trim().slice(0, 40);
    const extra = String(note || '').trim().slice(0, 200);
    task.states.excel = {
      status: '已登记',
      detail: `模拟人工确认 Excel 登记${sheet ? `：工作表 ${sheet}` : ''}${row ? `，第 ${row} 行` : ''}${taskNo ? `，任务编号 ${taskNo}` : ''}${extra ? `；备注：${extra}` : ''}。本服务未读取写回真实 Excel。`,
      sheetName: sheet,
      rowIndex: row,
      plTaskId: taskNo,
      updatedAt: now,
    };
    task.history.push({ at: now, stage: '已登记（模拟）', detail: task.states.excel.detail });
    task.updatedAt = now;
    await this.saveTask(task);
    return task;
  }

  /** 阶段2F：人工确认归档（模拟入口）。只改服务自身任务 JSON，不复制/移动/删除文件。 */
  async confirmArchivedSimulated(taskId, { targetPreview = '', note = '' } = {}) {
    const task = await this.getTask(taskId);
    if (!task) return null;
    if (task.mode !== 'simulate') throw new Error('仅允许更新模拟任务');
    if (task.states?.publish?.status !== '人工确认已发布' && task.states?.publish?.status !== '已正式发布') {
      throw new Error('尚未人工确认正式发布，不能归档');
    }
    if (task.states?.excel?.status !== '已登记') {
      throw new Error('尚未确认 Excel 已登记，不能归档');
    }
    const now = stageTime();
    const target = String(targetPreview || '').trim().slice(0, 300);
    const extra = String(note || '').trim().slice(0, 200);
    task.states.archive = {
      status: '已归档',
      detail: `模拟人工确认归档${target ? `：目标 ${target}` : ''}${extra ? `；备注：${extra}` : ''}。本服务未复制、未移动、未删除任何文件。`,
      targetPreview: target,
      updatedAt: now,
    };
    task.history.push({ at: now, stage: '已归档（模拟）', detail: task.states.archive.detail });
    task.updatedAt = now;
    await this.saveTask(task);
    return task;
  }

  /** 仅删除服务自身任务记录（模拟/未执行真实动作的任务），不影响源包与平台。 */
  async removeTask(taskId) {
    const task = await this.getTask(taskId);
    if (!task) return { removed: false };
    if (task.mode !== 'simulate'
      || task.states?.publish?.status !== '未发布'
      || task.states?.excel?.status !== '未登记'
      || task.states?.archive?.status !== '未归档') {
      return { removed: false, reason: '该任务涉及真实发布/登记/归档状态，不允许直接删除记录' };
    }
    await fs.rm(this._file(taskId), { force: true });
    return { removed: true };
  }
}

/** 校验任务键各段，命令层必须通过 makeTaskKey 生成，不接受正文/任意字符串。 */
export function validAccountId(accountId, allowedSet) {
  return typeof accountId === 'string' && allowedSet.includes(accountId);
}
export function isValidTaskId(id) { return /^tsk_[0-9]+_[0-9a-f]{8}$/.test(id); }
export { fss };
