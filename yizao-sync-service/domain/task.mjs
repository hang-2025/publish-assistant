import { TASK_STATUS, assertTaskStatusTransition, isTaskStatus, taskStatusFromLegacyStage } from './status.mjs';

export function createTask(input = {}) {
  const now = new Date().toISOString();
  const status = input.status || TASK_STATUS.PENDING;
  if (!isTaskStatus(status)) throw new Error(`Task 状态无效：${String(status)}`);
  return {
    id: String(input.id || input.taskId || ''),
    articleId: String(input.articleId || input.packageId || ''),
    platform: String(input.platform || ''),
    status,
    step: String(input.step || ''),
    progress: Number.isFinite(input.progress) ? input.progress : 0,
    createdAt: input.createdAt || now,
    updatedAt: input.updatedAt || now,
    error: input.error || null,
    retryable: Boolean(input.retryable),
  };
}
export function taskFromLegacyRecord(record = {}) {
  const stage = record.states?.draft?.stage || record.draft?.stage || '';
  return createTask({
    id: record.taskId || record.id,
    articleId: record.packageId,
    platform: record.platform,
    status: taskStatusFromLegacyStage(stage),
    step: stage,
    progress: record.progress || 0,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    error: record.error || (record.states?.draft?.stage === '失败' ? record.states?.draft?.detail : null),
    retryable: ['结果待核对（重启中断）', '结果未知（重启中断）', '失败'].includes(stage),
  });
}

/** Apply a canonical task transition without mutating the legacy task record. */
export function transitionTaskStatus(task, nextStatus, changes = {}) {
  assertTaskStatusTransition(task?.status, nextStatus);
  return {
    ...task,
    ...changes,
    status: nextStatus,
    updatedAt: new Date().toISOString(),
  };
}
