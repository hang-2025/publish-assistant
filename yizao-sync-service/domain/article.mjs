import {
  ARTICLE_STATUS, VALIDATION_STATUS, PUBLISH_STATUS, DRAFT_STATUS,
  EXCEL_STATUS, ARCHIVE_STATUS, assertArticleStatusTransition, isArticleStatus,
} from './status.mjs';

function text(value) { return typeof value === 'string' ? value : ''; }
function list(value) { return Array.isArray(value) ? value : []; }

/** Create a normalized Article without mutating the caller's object. */
export function createArticle(input = {}) {
  const now = new Date().toISOString();
  const issues = list(input.altIssues || input.validation?.issues);
  const validationStatus = input.validation?.status
    || (issues.length ? VALIDATION_STATUS.BLOCKED : VALIDATION_STATUS.UNKNOWN);
  const lifecycleStatus = input.lifecycleStatus || ARTICLE_STATUS.DISCOVERED;
  if (!isArticleStatus(lifecycleStatus)) throw new Error(`Article 状态无效：${String(lifecycleStatus)}`);
  return {
    id: text(input.id || input.packageId),
    packageId: text(input.packageId),
    title: text(input.title),
    sourcePath: text(input.sourcePath),
    platform: text(input.platform),
    category: text(input.category),
    content: input.content || { format: '', html: '', fingerprint: '' },
    images: list(input.images),
    altIssues: issues,
    validation: { status: validationStatus, issues, ...(input.validation || {}) },
    targets: list(input.targets),
    tasks: list(input.tasks),
    lifecycleStatus,
    publishStatus: input.publishStatus || PUBLISH_STATUS.NOT_PUBLISHED,
    draftStatus: input.draftStatus || DRAFT_STATUS.NOT_STARTED,
    excelStatus: input.excelStatus || EXCEL_STATUS.NOT_REGISTERED,
    archiveStatus: input.archiveStatus || ARCHIVE_STATUS.NOT_ARCHIVED,
    createdAt: input.createdAt || now,
    updatedAt: input.updatedAt || now,
  };
}
/** Convert the existing scan response into the canonical Article projection. */
export function articleFromScanResult(pkg, { rootName = '' } = {}) {
  const segments = list(pkg?.segments);
  const issueCount = Number(pkg?.issueCount || list(pkg?.issues).length || 0);
  const issues = list(pkg?.issues);
  return createArticle({
    id: pkg?.packageId,
    packageId: pkg?.packageId,
    title: pkg?.title || segments.at(-1) || '',
    sourcePath: pkg?.relativePath || '',
    platform: segments[1] || '',
    category: segments[2] || '',
    images: [],
    altIssues: issues,
    validation: {
      status: issueCount > 0 ? VALIDATION_STATUS.BLOCKED : VALIDATION_STATUS.PENDING,
      issueCount,
      issues,
    },
    targets: segments[1] ? [{ platform: segments[1], root: rootName }] : [],
  });
}

/** Enrich an indexed Article with the existing getPackage response. */
export function articleFromPackageDetail(detail, previous = {}) {
  const issues = list(detail?.issues);
  return createArticle({
    ...previous,
    id: detail?.packageId || previous.id,
    packageId: detail?.packageId || previous.packageId,
    title: detail?.title || previous.title,
    sourcePath: detail?.relativePath || previous.sourcePath,
    content: { format: 'html', html: detail?.html || '', fingerprint: previous.content?.fingerprint || '' },
    images: list(detail?.images),
    altIssues: issues.filter((issue) => /ALT|图片|图注/i.test(String(issue))),
    validation: {
      status: issues.length ? VALIDATION_STATUS.BLOCKED : VALIDATION_STATUS.VALID,
      issueCount: issues.length,
      issues,
    },
    lifecycleStatus: issues.length ? ARTICLE_STATUS.DISCOVERED : ARTICLE_STATUS.VALIDATED,
    updatedAt: new Date().toISOString(),
  });
}

/** Apply a canonical lifecycle transition without mutating the stored Article. */
export function transitionArticleLifecycle(article, nextStatus, changes = {}) {
  assertArticleStatusTransition(article?.lifecycleStatus, nextStatus);
  return {
    ...article,
    ...changes,
    lifecycleStatus: nextStatus,
    updatedAt: new Date().toISOString(),
  };
}
