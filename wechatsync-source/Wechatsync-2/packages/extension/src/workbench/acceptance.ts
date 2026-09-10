export const EXTENSION_BUILD_ID = 'stage7-xiaohongshu-draft-v3.6'
export const ACCEPTANCE_PACKAGE_VERSION = 36
export const ACCEPTANCE_PACKAGE_LABEL = '3.6'
export const EXPECTED_SERVICE_VERSION = '0.6.0-stage7-xiaohongshu-draft'
export const EXPECTED_PROTOCOL = { name: 'yizao-local-service', version: 2 } as const

export interface ServiceHealth {
  ok: boolean
  name?: string
  version: string
  protocol: { name: string; version: number }
  build?: { packageVersion?: number; id?: string; extensionBuildId?: string }
}

export function serviceCompatibility(info: ServiceHealth | null | undefined) {
  const reasons: string[] = []
  if (!info?.ok) reasons.push('本地服务健康检查未通过')
  if (info?.name !== 'yizao-sync-service') reasons.push('本地服务身份不匹配')
  if (info?.version !== EXPECTED_SERVICE_VERSION) reasons.push(`服务版本不匹配（需要 ${EXPECTED_SERVICE_VERSION}）`)
  if (info?.protocol?.name !== EXPECTED_PROTOCOL.name || info?.protocol?.version !== EXPECTED_PROTOCOL.version) {
    reasons.push(`协议版本不匹配（需要 ${EXPECTED_PROTOCOL.name}/${EXPECTED_PROTOCOL.version}）`)
  }
  if (info?.build?.id !== EXTENSION_BUILD_ID || info?.build?.extensionBuildId !== EXTENSION_BUILD_ID) {
    reasons.push(`验收构建不匹配（需要 ${EXTENSION_BUILD_ID}）`)
  }
  if (info?.build?.packageVersion !== ACCEPTANCE_PACKAGE_VERSION) reasons.push(`验收包版本不匹配（需要 v${ACCEPTANCE_PACKAGE_LABEL}）`)
  return { ok: reasons.length === 0, reasons }
}

const REQUIRED_CHECKS = ['service', 'token', 'origin', 'version', 'login', 'article', 'snapshot', 'html-fidelity-source', 'draft-gate', 'publish-gate']
export function acceptanceChecksPassed(checks: Array<{ key: string; ok: boolean }>) {
  const byKey = new Map(checks.map((item) => [item.key, item.ok]))
  return REQUIRED_CHECKS.every((key) => byKey.get(key) === true)
}

export interface AcceptanceEvidenceInput {
  platform?: 'zhihu' | 'sohu' | 'toutiao' | 'netease' | 'xiaohongshu'
  timestamp: string
  serviceVersion: string
  protocolName: string
  protocolVersion: number
  extensionVersion: string
  articleId: string
  packageId: string
  snapshotId: string
  contentHash: string
  imageCount: number
  taskId: string
  postId: string
  draftUrl: string
  draftOnly: boolean
  readBackVerified: boolean
  fidelityVerified: boolean
  fidelityOverall: 'PASS' | 'DEGRADED' | 'UNSUPPORTED' | 'FAIL'
  fidelitySummary: { pass: number; degraded: number; unsupported: number; fail: number }
  finalTaskStatus: string
  saveDraftDeniedBeforeConfirmation: boolean
  publishDenied: boolean
}

/** Explicit allowlist: never add article text, credentials, account data or local paths. */
export function buildAcceptanceEvidence(input: AcceptanceEvidenceInput) {
  const platform = input.platform || 'zhihu'
  return {
    schema: platform === 'zhihu' ? 'yizao-stage3-zhihu-acceptance-evidence' : 'yizao-guarded-draft-acceptance-evidence',
    version: 2,
    acceptanceId: `acceptance-${input.taskId}-${input.snapshotId.slice(-12)}`,
    timestamp: input.timestamp,
    serviceVersion: input.serviceVersion,
    protocol: { name: input.protocolName, version: input.protocolVersion },
    extensionBuildId: EXTENSION_BUILD_ID,
    extensionVersion: input.extensionVersion,
    articleId: input.articleId,
    packageId: input.packageId,
    snapshotId: input.snapshotId,
    contentHash: input.contentHash,
    imageCount: input.imageCount,
    platform,
    taskId: input.taskId,
    draft: {
      postId: input.postId,
      url: input.draftUrl,
      draftOnly: input.draftOnly,
      readBackVerified: input.readBackVerified,
      fidelityVerified: input.fidelityVerified,
    },
    fidelity: { overall: input.fidelityOverall, summary: input.fidelitySummary },
    finalTaskStatus: input.finalTaskStatus,
    safetyGates: {
      saveDraftDeniedBeforeConfirmation: input.saveDraftDeniedBeforeConfirmation,
      publishDenied: input.publishDenied,
      publicPublishEnabled: false,
      excelWriteEnabled: false,
      fileMoveDeleteEnabled: false,
      realArchiveEnabled: false,
    },
  }
}
