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

const ARTICLE_TRANSITIONS = Object.freeze({
  [ARTICLE_STATUS.DISCOVERED]: Object.freeze([ARTICLE_STATUS.VALIDATED, ARTICLE_STATUS.FAILED]),
  [ARTICLE_STATUS.VALIDATED]: Object.freeze([ARTICLE_STATUS.READY, ARTICLE_STATUS.FAILED]),
  [ARTICLE_STATUS.READY]: Object.freeze([ARTICLE_STATUS.QUEUED, ARTICLE_STATUS.PROCESSING, ARTICLE_STATUS.FAILED]),
  [ARTICLE_STATUS.QUEUED]: Object.freeze([ARTICLE_STATUS.PROCESSING, ARTICLE_STATUS.FAILED]),
  [ARTICLE_STATUS.PROCESSING]: Object.freeze([ARTICLE_STATUS.DRAFT_SAVED, ARTICLE_STATUS.FAILED]),
  [ARTICLE_STATUS.DRAFT_SAVED]: Object.freeze([ARTICLE_STATUS.WAITING_USER_CONFIRMATION, ARTICLE_STATUS.FAILED]),
  [ARTICLE_STATUS.WAITING_USER_CONFIRMATION]: Object.freeze([ARTICLE_STATUS.PUBLISHED, ARTICLE_STATUS.FAILED]),
  [ARTICLE_STATUS.PUBLISHED]: Object.freeze([ARTICLE_STATUS.REGISTERED]),
  [ARTICLE_STATUS.REGISTERED]: Object.freeze([ARTICLE_STATUS.ARCHIVED]),
  [ARTICLE_STATUS.ARCHIVED]: Object.freeze([]),
  [ARTICLE_STATUS.FAILED]: Object.freeze([]),
});

const TASK_TRANSITIONS = Object.freeze({
  [TASK_STATUS.PENDING]: Object.freeze([TASK_STATUS.VALIDATING, TASK_STATUS.FAILED, TASK_STATUS.CANCELLED]),
  [TASK_STATUS.VALIDATING]: Object.freeze([TASK_STATUS.READY, TASK_STATUS.FAILED, TASK_STATUS.CANCELLED]),
  [TASK_STATUS.READY]: Object.freeze([TASK_STATUS.RUNNING, TASK_STATUS.FAILED, TASK_STATUS.CANCELLED]),
  [TASK_STATUS.RUNNING]: Object.freeze([TASK_STATUS.UPLOADING, TASK_STATUS.FAILED, TASK_STATUS.CANCELLED]),
  [TASK_STATUS.UPLOADING]: Object.freeze([TASK_STATUS.FILLING, TASK_STATUS.FAILED, TASK_STATUS.CANCELLED]),
  [TASK_STATUS.FILLING]: Object.freeze([TASK_STATUS.SAVING_DRAFT, TASK_STATUS.FAILED, TASK_STATUS.CANCELLED]),
  [TASK_STATUS.SAVING_DRAFT]: Object.freeze([TASK_STATUS.WAITING_CONFIRMATION, TASK_STATUS.FAILED, TASK_STATUS.CANCELLED]),
  [TASK_STATUS.WAITING_CONFIRMATION]: Object.freeze([TASK_STATUS.PUBLISHED, TASK_STATUS.FAILED, TASK_STATUS.CANCELLED]),
  [TASK_STATUS.PUBLISHED]: Object.freeze([]),
  [TASK_STATUS.FAILED]: Object.freeze([]),
  [TASK_STATUS.CANCELLED]: Object.freeze([]),
});

function canTransition(transitions, current, next) {
  if (!Object.prototype.hasOwnProperty.call(transitions, current)) return false;
  if (!Object.prototype.hasOwnProperty.call(transitions, next)) return false;
  return current === next || transitions[current].includes(next);
}

function assertTransition(kind, transitions, current, next) {
  if (!canTransition(transitions, current, next)) {
    throw new Error(`${kind} 非法状态转换：${String(current)} -> ${String(next)}`);
  }
  return next;
}

export function isArticleStatus(value) {
  return Object.prototype.hasOwnProperty.call(ARTICLE_TRANSITIONS, value);
}

export function isTaskStatus(value) {
  return Object.prototype.hasOwnProperty.call(TASK_TRANSITIONS, value);
}

export function canTransitionArticleStatus(current, next) {
  return canTransition(ARTICLE_TRANSITIONS, current, next);
}

export function assertArticleStatusTransition(current, next) {
  return assertTransition('Article', ARTICLE_TRANSITIONS, current, next);
}

export function canTransitionTaskStatus(current, next) {
  return canTransition(TASK_TRANSITIONS, current, next);
}

export function assertTaskStatusTransition(current, next) {
  return assertTransition('Task', TASK_TRANSITIONS, current, next);
}

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
