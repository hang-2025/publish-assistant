/**
 * Canonical lifecycle vocabulary for the publish assistant.
 *
 * Existing HTTP responses intentionally keep their current Chinese labels.
 * Conversion helpers in the domain layer map those legacy labels to these
 * stable values so future services do not invent another set of strings.
 */
export const ARTICLE_STATUS = Object.freeze({
  DISCOVERED: 'discovered',
  VALIDATED: 'validated',
  READY: 'ready',
  QUEUED: 'queued',
  PROCESSING: 'processing',
  DRAFT_SAVED: 'draft_saved',
  WAITING_USER_CONFIRMATION: 'waiting_user_confirmation',
  PUBLISHED: 'published',
  REGISTERED: 'registered',
  ARCHIVED: 'archived',
  FAILED: 'failed',
});

export const VALIDATION_STATUS = Object.freeze({
  UNKNOWN: 'unknown',
  PENDING: 'pending',
  VALID: 'valid',
  BLOCKED: 'blocked',
});

export const PUBLISH_STATUS = Object.freeze({
  NOT_PUBLISHED: 'not_published',
  WAITING_USER_CONFIRMATION: 'waiting_user_confirmation',
  PUBLISHED: 'published',
  FAILED: 'failed',
});

export const DRAFT_STATUS = Object.freeze({
  NOT_STARTED: 'not_started',
  PROCESSING: 'processing',
  SIMULATED: 'simulated',
  SAVED: 'saved',
  UNKNOWN: 'unknown',
  FAILED: 'failed',
});

export const EXCEL_STATUS = Object.freeze({
  NOT_REGISTERED: 'not_registered',
  REGISTERED: 'registered',
  FAILED: 'failed',
});

export const ARCHIVE_STATUS = Object.freeze({
  NOT_ARCHIVED: 'not_archived',
  READY: 'ready',
  ARCHIVED: 'archived',
  FAILED: 'failed',
});

export const TASK_STATUS = Object.freeze({
  PENDING: 'pending',
  VALIDATING: 'validating',
  READY: 'ready',
  RUNNING: 'running',
  UPLOADING: 'uploading',
  FILLING: 'filling',
  SAVING_DRAFT: 'saving_draft',
  WAITING_CONFIRMATION: 'waiting_confirmation',
  PUBLISHED: 'published',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
});

export const LEGACY_DRAFT_STAGE_TO_TASK_STATUS = Object.freeze({
  '未执行': TASK_STATUS.PENDING,
  '校验中': TASK_STATUS.VALIDATING,
  '校验发送快照': TASK_STATUS.VALIDATING,
  '获取站点锁（模拟）': TASK_STATUS.READY,
  '模拟填写后台': TASK_STATUS.FILLING,
  '上传中': TASK_STATUS.UPLOADING,
  '保存中': TASK_STATUS.SAVING_DRAFT,
  '等待用户最终提交（模拟）': TASK_STATUS.WAITING_CONFIRMATION,
  '模拟完成（未保存草稿）': TASK_STATUS.WAITING_CONFIRMATION,
  '结果待核对（重启中断）': TASK_STATUS.FAILED,
  '结果未知（重启中断）': TASK_STATUS.FAILED,
  '失败': TASK_STATUS.FAILED,
});

export function taskStatusFromLegacyStage(stage) {
  return LEGACY_DRAFT_STAGE_TO_TASK_STATUS[String(stage || '')] || TASK_STATUS.PENDING;
}
