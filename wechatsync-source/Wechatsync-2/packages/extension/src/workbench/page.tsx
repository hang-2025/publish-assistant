import { useEffect, useMemo, useRef, useState } from 'react'
import { sanitizeHtml, previewDocument } from '../local-import/importer'
import { call, health, ServiceAuthError, ServiceUnreachableError, setToken } from './service'
import { confirmArchivedSimulated as confirmLocalArchivedSimulated, confirmExcelRegisteredSimulated as confirmLocalExcelRegisteredSimulated, confirmPublishedSimulated as confirmLocalPublishedSimulated, createSimulatedTask, markPackageIdsStale, refreshTasks, removeTask as removeSimTask, restoreTasks, type SimTask } from './tasks'

/**
 * 易造发布助手 · 工作台（阶段2J：可复制/下载的验收材料，仍只读 + 模拟）
 * - 只读扫描本地文章目录、安全预览正文、图片与 ALT/图注对照；
 * - 官网/百家号：经本地服务生成「执行预览与发送快照」，可运行「模拟发布流程」，
 *   终态停在「等待用户最终提交（模拟）」，绝不自动点击最终发布；
 * - 知乎/搜狐：扩展本地「草稿流程预览」模拟（不调用平台接口）；
 * - 头条/网易/小红书等：标注「待适配」，不提供执行入口；
 * - 不上传文章、不修改 Excel、不移动文件、不触发任何真实发布。
 */

interface PkgSummary {
  packageId: string | null
  relativePath: string
  segments: string[]
  title: string
  imageCount: number
  altCount: number
  issueCount: number
  issues: string[]
  notes: string[]
}
interface PkgImage {
  number: number; name: string; dir: string; bytes: number; sha256: string; dataUrl: string
  alt: string; altSource: string; duplicateOf: string | null; error?: string
}
interface PkgDetail {
  packageId: string; root: string; relativePath: string; title: string
  seo: Record<string, string>; html: string; alts: { number: number; alt: string }[]; altSource: string
  images: PkgImage[]; issues: string[]; notes: string[]; fileList: { relative: string; bytes: number }[]
  occurrences: {
    occurrenceId: string; position: number; src: string; name: string; assetNumber: number | null
    assetName: string; assetDir: string; assetMatch: string; manifestAlt: string; htmlAlt: string
    effectiveAlt: string; altSource: string; altConflict: boolean; caption: string; captionSource: string
  }[]
}

/**
 * 能力模型（P0.4 + P1 工作台）：
 * 文章卡片按来源分类 → 发布流程预览 / 草稿流程预览 / 待适配（禁用）。
 * 能力标签：只读、模拟、待适配、需要另行授权。
 */
type CapKind = 'publish-preview' | 'draft-preview' | 'not-ready'
interface Capability {
  kind: CapKind
  /** 卡片主动作文案 */
  label: string
  /** 能力标签 chips */
  tags: string[]
  /** 知乎/搜狐草稿模拟用的平台 */
  platform?: { id: string; name: string }
  /** 官网/百家号：服务端命令使用的站点键 */
  siteKey?: string
  siteName?: string
  explain: string
}

const SITE_ADAPTERS: Record<string, string> = {
  'www.eyzao.com': 'emcms', 'eyzao.com': 'emcms', 'www.eyzao.cn': 'fhlcms', 'eyzao.cn': 'fhlcms',
}

function publishPreview(siteKey: string, siteName: string): Capability {
  return {
    kind: 'publish-preview', label: '发布流程预览', siteKey, siteName,
    tags: ['只读', '模拟', '需要另行授权'],
    explain: `真实发布到「${siteName}」需要另行授权；当前只在本地服务内生成执行预览与发送快照，模拟流程停在「等待用户最终提交」，绝不自动发布。`,
  }
}
function draftPreview(platform: { id: string; name: string }): Capability {
  return {
    kind: 'draft-preview', label: '草稿流程预览', platform,
    tags: ['只读', '模拟'],
    explain: `草稿流程仅本地模拟：不调用「${platform.name}」真实接口，终态为「模拟完成（未保存草稿）」，保存草稿 ≠ 已发布。真实投稿需要另行授权。`,
  }
}
function notReady(why: string): Capability {
  return { kind: 'not-ready', label: '待适配', tags: ['只读', '待适配', '需要另行授权'], explain: `${why}：本轮不提供发布或草稿流程入口，仅作只读展示。` }
}

function platformFromSegments(segments: string[], catalog: CapabilityPlatform[]) {
  const [kind = '未分类', source = '未分类'] = segments
  const candidates = new Set([source.toLowerCase(), source.toLowerCase().replace(/^www\./, '')])
  return catalog.find((item) => candidates.has(item.id.toLowerCase())
    || candidates.has(item.name.toLowerCase())
    || item.aliases?.some((alias) => candidates.has(alias.toLowerCase()))) || null
}

/** 按服务端统一能力决定动作；目录只负责提供平台标识。 */
function capabilityFor(segments: string[], catalog: CapabilityPlatform[]): Capability {
  const [kind = '未分类'] = segments
  const platform = platformFromSegments(segments, catalog)
  if (!platform) return notReady(kind === '官网' ? '该官网域名尚未接入适配器' : '该平台尚未接入适配器')
  const workflow = platform.workflow || ({
    'simulation-ready': 'official-simulation',
    'draft-simulation': 'draft-simulation',
    'not-adapted': 'unsupported',
  } as Record<string, string>)[platform.status]
  if (workflow === 'official-simulation') return publishPreview(platform.id, platform.name)
  if (workflow === 'draft-simulation') return draftPreview({ id: platform.id, name: platform.name })
  return notReady('该平台尚未接入适配器')
}

interface PackageCategory { name: string; packages: PkgSummary[] }
interface PackageSourceGroup { key: string; name: string; badge: string; categories: PackageCategory[]; count: number }

/** 把扫描结果按“网站/平台 → 产品分类 → 文章”整理，保留目录原有顺序。 */
function groupPackages(packages: PkgSummary[], catalog: CapabilityPlatform[]): PackageSourceGroup[] {
  const sources = new Map<string, { name: string; badge: string; categories: Map<string, PkgSummary[]> }>()
  for (const pkg of packages.filter((item) => item.packageId)) {
    const [kind = '未分类', source = '未分类', category = '未分类'] = pkg.segments
    const isWebsite = kind === '官网' || /(?:^|\.)eyzao\.(?:com|cn)$/i.test(source)
    const platform = platformFromSegments(pkg.segments, catalog)
    const sourceKey = `${kind}/${source}`
    if (!sources.has(sourceKey)) {
      sources.set(sourceKey, {
        name: platform?.name || source,
        badge: isWebsite ? (SITE_ADAPTERS[source.toLowerCase()] || '官网') : (platform?.id || source.toLowerCase()),
        categories: new Map(),
      })
    }
    const group = sources.get(sourceKey)!
    if (!group.categories.has(category)) group.categories.set(category, [])
    group.categories.get(category)!.push(pkg)
  }
  return Array.from(sources, ([key, source]) => ({
    key, name: source.name, badge: source.badge,
    categories: Array.from(source.categories, ([name, items]) => ({ name, packages: items })),
    count: Array.from(source.categories.values()).reduce((sum, items) => sum + items.length, 0),
  }))
}

function packageDate(pkg: PkgSummary): string {
  return pkg.segments.find((segment) => /^\d{4}-\d{2}-\d{2}/.test(segment)) || '日期未标注'
}

function errMessage(e: unknown): string {
  if (e instanceof ServiceAuthError) return '本地服务未配对：请在「服务配对」中粘贴服务控制台显示的令牌。'
  if (e instanceof ServiceUnreachableError) return '无法连接本地服务：请先启动 yizao-sync-service（node server.mjs）。'
  return (e as Error).message
}

function fmtTime(v: string | number | undefined): string {
  if (!v) return ''
  const d = typeof v === 'string' ? new Date(v) : new Date(v as number)
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString()
}

/** 把服务返回的正文 HTML 与图片 dataUrl 拼成安全预览（复用本地导入的清理规则）。 */
function buildPreview(detail: PkgDetail): { html: string; missing: string[] } {
  const doc = new DOMParser().parseFromString(sanitizeHtml(detail.html), 'text/html')
  const byName = new Map<string, PkgImage[]>()
  for (const img of detail.images) {
    if (!img.dataUrl) continue
    const key = img.name.toLowerCase()
    byName.set(key, [...(byName.get(key) || []), img])
  }
  const missing: string[] = []
  for (const img of Array.from(doc.querySelectorAll('img'))) {
    const src = img.getAttribute('src') || ''
    let name = src.split(/[\\/]/).pop() || ''
    try { name = decodeURIComponent(name) } catch { /* literal percent */ }
    const matches = byName.get(name.toLowerCase()) || []
    if (matches.length === 1) {
      img.setAttribute('src', matches[0].dataUrl)
      if (matches[0].alt) img.setAttribute('alt', matches[0].alt)
    } else {
      missing.push(name || '(无地址)')
      img.removeAttribute('src')
    }
  }
  return { html: doc.body.innerHTML, missing }
}

/** 本地服务返回的官网/百家号任务记录（sanitize 后：无正文/无令牌/无 Cookie）。 */
interface ServerTask {
  taskId: string; taskKey: string; mode: string; packageId: string; rootName: string; relativePath: string
  platform: string; platformName: string; platformKind: string; accountId: string; accountLabel: string
  title: string; contentVersion: string; contentVersionShort: string; snapshotId: string; runState: string
  draft: { stage: string; detail: string; updatedAt: string }
  publish: { status: string; detail: string; updatedAt: string }
  excel: { status: string; detail: string; updatedAt: string }
  archive: { status: string; detail: string; updatedAt: string }
  createdAt: string; updatedAt: string; finishedAt?: string
}

interface Gate { executable: boolean; blocks: string[]; warnings?: string[] }
interface OfficialPreview {
  preview: {
    siteKey: string; siteName: string; platformName: string; adapter: string
    account: string; accountId: string; lockKey: string; finalAction: string; note: string
    gate: Gate; contentVersionShort: string
    content: { title?: string; imageCount: number; byteCount?: number; seoCategory?: string }
    assets: { dir: string; name: string; sha256: string; bytes: number }[]
    occurrences: { position: number; name?: string; alt?: string; caption?: string; captionAppended?: boolean }[]
  }
  snapshot: { snapshotId: string; gate: Gate; contentVersion: string; contentVersionShort: string }
  taskKey: string
}
interface SimOfficialResponse {
  mode: 'simulate' | 'blocked'; started: boolean; siteKey: string
  reason?: string; detail?: string; gate?: Gate; task?: ServerTask | null; busy?: ServerTask | null
}
interface ExcelRegistrationPreview {
  mode: 'excel-registration-preview'
  readOnly: boolean
  excel: { configured: boolean; resolved: string; sheetName?: string }
  query: { plTaskId?: string; platform?: string; category?: string; title?: string; date?: string }
  notice: string
  registration: {
    ok: boolean
    error?: string
    sheets: { name: string; rows: number; cols: number; header: string }[]
    targetSheet?: string
    columnMapPreview?: { suggested: Record<string, number>; matched: string[]; unmatched: string[]; conflicts: unknown[]; ok: boolean }
    resolution?: {
      kind: 'unique' | 'append' | 'conflict' | 'needs-binding' | 'column-conflict'
      code: string
      notice?: string
      matched?: { index: number; taskId: string; platform: string; category: string; title: string; date: string; status: string; link: string } | null
      rows?: { index: number; taskId: string; platform: string; category: string; title: string; date: string; status: string; link: string }[]
      appendRow?: { index: number; taskId: string; platform: string; category: string; title: string; date: string } | null
    }
  }
}
interface CapabilityPlatform {
  id: string
  name: string
  group: string
  status: 'simulation-ready' | 'draft-simulation' | 'not-adapted' | string
  currentActions: string[]
  plannedActions: string[]
  evidence: string[]
  risks: string[]
  aliases?: string[]
  workflow?: 'official-simulation' | 'draft-simulation' | 'unsupported' | string
  capabilities?: {
    prepare: boolean
    simulate: boolean
    saveDraft: boolean
    publish: boolean
    autoPublish: boolean
    imageAlt: boolean
    visibleCaption: boolean
    verified: boolean
  }
}
interface CapabilitiesResponse {
  phase: string
  realActionsEnabled: boolean
  requirementsBeforeRealActions: string[]
  actions?: Record<string, string>
  platforms: CapabilityPlatform[]
}

// Compatibility catalog for initial render and older mocked services. Once
// getCapabilities succeeds, the server-provided registry replaces this data.
const FALLBACK_PLATFORM_CAPABILITIES: CapabilityPlatform[] = [
  ...[
    ['eyzao.com', '易造官网（eyzao.com）', ['www.eyzao.com']],
    ['eyzao.cn', '易造官网（eyzao.cn）', ['www.eyzao.cn']],
    ['yzfanglei.com', '易造官网（yzfanglei.com）', ['www.yzfanglei.com']],
    ['baijiahao', '百家号', ['百家号']],
  ].map(([id, name, aliases]) => ({
    id: id as string, name: name as string, aliases: aliases as string[], group: id === 'baijiahao' ? '主流平台' : '官网',
    status: 'simulation-ready', workflow: 'official-simulation', currentActions: [], plannedActions: [], evidence: [], risks: [],
  })),
  ...[
    ['zhihu', '知乎', ['知乎']], ['sohu', '搜狐号', ['搜狐', '搜狐号']],
  ].map(([id, name, aliases]) => ({
    id: id as string, name: name as string, aliases: aliases as string[], group: '主流平台',
    status: 'draft-simulation', workflow: 'draft-simulation', currentActions: [], plannedActions: [], evidence: [], risks: [],
  })),
  ...[
    ['toutiao', '头条号'], ['netease', '网易号'], ['xiaohongshu', '小红书'],
  ].map(([id, name]) => ({
    id, name, aliases: [], group: '待适配平台', status: 'not-adapted', workflow: 'unsupported',
    currentActions: [], plannedActions: [], evidence: [], risks: [],
  })),
]
interface RealActionGateCheck {
  allowed: boolean
  action: string
  actionName: string
  platform: string
  platformName: string
  policy: string
  reason: string
  requirements: string[]
}
interface RealExecutionChecklist {
  mode: 'real-execution-checklist'
  readOnly: boolean
  generatedAt: string
  package: PreflightResponse['package']
  platform: PreflightResponse['platform']
  summary: {
    executableInThisBuild: boolean
    allowedRealActions: number
    closedRealActions: number
    blocks: string[]
    warnings: string[]
  }
  checklistMarkdown: string
  acceptanceTemplateMarkdown: string
  exportMarkdown: string
  exportFileName: string
  notice: string
}
interface PreflightResponse {
  mode: 'preflight'
  readOnly: boolean
  package: { packageId: string; rootName: string; relativePath: string; title: string }
  platform: { requested: string; siteKey: string; derived: string[]; reason: string }
  snapshot?: {
    siteKey: string; platformName: string; account: string; finalAction: string
    gate: Gate; contentVersionShort: string; snapshotId: string; imageCount: number; occurrenceCount: number
  } | null
  registration: { configured: boolean; status: string; notice?: string; query?: Record<string, string>; preview?: ExcelRegistrationPreview['registration'] }
  archive: { configured: boolean; targetRoot?: string; targetPreview?: string; status: string; notice: string }
  gates: Record<string, { allowed: boolean; actionName: string; reason: string; policy: string }>
  summary: { executableInThisBuild: boolean; blocks: string[]; warnings: string[]; nextStep: string }
  notice: string
}

interface ArchiveTaskLine {
  key: string
  packageId: string
  title: string
  relativePath: string
  platform: string
  platformName: string
  draftStage: string
  publishStatus: string
  excelStatus: string
  archiveStatus: string
  updatedAt: string | number
}

interface ArchivePackageGroup {
  packageId: string
  title: string
  relativePath: string
  lines: ArchiveTaskLine[]
  ready: boolean
  state: 'blocked' | 'ready' | 'done'
  stateLabel: string
  reasons: string[]
}
type ArchivePackageState = ArchivePackageGroup['state']

type CaptionPolicy = {
  official: 'keep-existing-only' | 'use-existing-alt-after-preview' | 'disabled'
  baijiahao: 'keep-existing-only' | 'use-existing-alt-after-preview' | 'disabled'
  draft: 'keep-existing-only' | 'use-existing-alt-after-preview' | 'disabled'
}

const DEFAULT_CAPTION_POLICY: CaptionPolicy = {
  official: 'keep-existing-only',
  baijiahao: 'keep-existing-only',
  draft: 'use-existing-alt-after-preview',
}

function formatPlatformValues(values?: Record<string, string[]>) {
  const entries = Object.entries(values || {
    'eyzao.com': ['eyzao.com', 'www.eyzao.com'],
    'eyzao.cn': ['eyzao.cn', 'www.eyzao.cn'],
    baijiahao: ['baijiahao', '百家号'],
    zhihu: ['zhihu', '知乎'],
    sohu: ['sohu', '搜狐', '搜狐号'],
  })
  return entries.map(([key, list]) => `${key} = ${(list || []).join('，')}`).join('\n')
}

function parsePlatformValues(text: string) {
  const result: Record<string, string[]> = {}
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const [keyPart, ...rest] = line.split('=')
    const key = keyPart.trim()
    const valueText = rest.join('=').trim()
    if (!key || !valueText) throw new Error(`平台映射格式不对：${line}`)
    result[key] = valueText.split(/[，,]/).map((item) => item.trim()).filter(Boolean)
  }
  return result
}

function archiveGroupsFromTasks(serverTasks: ServerTask[], localTasks: SimTask[]): ArchivePackageGroup[] {
  const lines: ArchiveTaskLine[] = [
    ...serverTasks.map((t) => ({
      key: t.taskId,
      packageId: t.packageId,
      title: t.title,
      relativePath: t.relativePath,
      platform: t.platform,
      platformName: t.platformName || t.platform,
      draftStage: t.draft?.stage || '未执行',
      publishStatus: t.publish?.status || '未发布',
      excelStatus: t.excel?.status || '未登记',
      archiveStatus: t.archive?.status || '未归档',
      updatedAt: t.updatedAt,
    })),
    ...localTasks.map((t) => ({
      key: t.id,
      packageId: t.packageId,
      title: t.title,
      relativePath: t.relativePath,
      platform: t.platform,
      platformName: t.platformName,
      draftStage: t.draft.stage,
      publishStatus: t.publish,
      excelStatus: t.register,
      archiveStatus: t.archive,
      updatedAt: t.updatedAt,
    })),
  ].filter((line) => line.packageId)
  const map = new Map<string, ArchiveTaskLine[]>()
  for (const line of lines) map.set(line.packageId, [...(map.get(line.packageId) || []), line])
  return [...map.entries()].map(([packageId, groupLines]) => {
    const reasons = groupLines.flatMap((line) => {
      const lineReasons: string[] = []
      if (!isPublished(line.publishStatus)) lineReasons.push(`${line.platformName}：尚未人工确认正式发布（当前 ${line.publishStatus || line.draftStage}）`)
      if (!isRegistered(line.excelStatus)) lineReasons.push(`${line.platformName}：尚未人工确认 Excel 已登记（当前 ${line.excelStatus}）`)
      return lineReasons
    })
    const first = groupLines[0]
    const allArchived = groupLines.length > 0 && groupLines.every((line) => isArchived(line.archiveStatus))
    const ready = reasons.length === 0 && groupLines.length > 0 && !allArchived
    const state: ArchivePackageState = allArchived ? 'done' : (ready ? 'ready' : 'blocked')
    return {
      packageId,
      title: first.title,
      relativePath: first.relativePath,
      lines: groupLines.sort((a, b) => a.platformName.localeCompare(b.platformName, 'zh-Hans-CN')),
      ready,
      state,
      stateLabel: state === 'done' ? '已模拟归档完成' : (state === 'ready' ? '可确认归档' : '不可归档'),
      reasons,
    }
  }).sort((a, b) => a.title.localeCompare(b.title, 'zh-Hans-CN'))
}

function isPublished(status: string) {
  return status === '人工确认已发布' || status === '已正式发布'
}

function isRegistered(status: string) {
  return status === '已登记'
}

function isArchived(status: string) {
  return status === '已归档'
}

function taskSteps(input: { draft: string; publish: string; excel: string; archive: string }) {
  return [
    { key: 'draft', label: '草稿/流程', value: input.draft, state: input.draft.includes('等待') || input.draft.includes('完成') ? 'done' : 'pending' },
    { key: 'publish', label: '确认发布', value: input.publish, state: isPublished(input.publish) ? 'done' : 'pending' },
    { key: 'excel', label: '确认登记', value: input.excel, state: isRegistered(input.excel) ? 'done' : (isPublished(input.publish) ? 'ready' : 'locked') },
    { key: 'archive', label: '确认归档', value: input.archive, state: isArchived(input.archive) ? 'done' : (isPublished(input.publish) && isRegistered(input.excel) ? 'ready' : 'locked') },
  ]
}

export function Workbench() {
  const [serviceState, setServiceState] = useState<'checking' | 'ok' | 'unreachable' | 'unpaired'>('checking')
  const [tokenInput, setTokenInput] = useState('')
  const [error, setError] = useState('')
  const [tab, setTab] = useState<'library' | 'tasks' | 'platforms' | 'safety'>('library')
  const [roots, setRoots] = useState<{ unpublished?: string; published?: string; archive?: string }>({})
  const [rootInputs, setRootInputs] = useState({ unpublished: '', published: '', archive: '' })
  const [excel, setExcel] = useState<{ planPath?: string; sheetName?: string }>({})
  const [excelInputs, setExcelInputs] = useState({ planPath: '', sheetName: '' })
  const [platformValuesText, setPlatformValuesText] = useState(formatPlatformValues())
  const [captionPolicy, setCaptionPolicy] = useState<CaptionPolicy>(DEFAULT_CAPTION_POLICY)
  const [templateText, setTemplateText] = useState('')
  const [templateNote, setTemplateNote] = useState('')
  const [publishLinks, setPublishLinks] = useState<Record<string, string>>({})
  const [scans, setScans] = useState<Record<string, PkgSummary[]>>({})
  const [scanning, setScanning] = useState('')
  const [detail, setDetail] = useState<PkgDetail | null>(null)
  const [detailError, setDetailError] = useState('')
  const [openCap, setOpenCap] = useState<Capability | null>(null)
  const [tasks, setTasks] = useState<SimTask[]>([])
  const [serverTasks, setServerTasks] = useState<ServerTask[]>([])
  const [officialPreview, setOfficialPreview] = useState<OfficialPreview | null>(null)
  const [officialBusy, setOfficialBusy] = useState<'prepare' | 'simulate' | ''>('')
  const [officialNote, setOfficialNote] = useState('')
  const [registrationPreview, setRegistrationPreview] = useState<ExcelRegistrationPreview | null>(null)
  const [registrationBusy, setRegistrationBusy] = useState(false)
  const [registrationNote, setRegistrationNote] = useState('')
  const [capabilities, setCapabilities] = useState<CapabilitiesResponse | null>(null)
  const [gateChecks, setGateChecks] = useState<RealActionGateCheck[]>([])
  const [gateBusy, setGateBusy] = useState(false)
  const [preflight, setPreflight] = useState<PreflightResponse | null>(null)
  const [preflightBusy, setPreflightBusy] = useState(false)
  const [preflightNote, setPreflightNote] = useState('')
  const [checklist, setChecklist] = useState<RealExecutionChecklist | null>(null)
  const [checklistBusy, setChecklistBusy] = useState(false)
  const [checklistNote, setChecklistNote] = useState('')
  const pollRef = useRef<number>()
  const archiveGroups = useMemo(() => archiveGroupsFromTasks(serverTasks, tasks), [serverTasks, tasks])

  async function probeService() {
    setServiceState('checking')
    try {
      await health()
      try { await call('getConfig'); setServiceState('ok') } catch (e) { setServiceState(e instanceof ServiceAuthError ? 'unpaired' : 'ok') }
    } catch {
      setServiceState('unreachable')
    }
  }

  useEffect(() => { probeService() }, [])

  // 模拟任务推进的轮询刷新（扩展本地知乎/搜狐草稿模拟）
  useEffect(() => {
    pollRef.current = window.setInterval(() => { refreshTasks().then(setTasks) }, 800)
    restoreTasks().then(setTasks)
    return () => window.clearInterval(pollRef.current)
  }, [])

  // 官网/百家号服务端任务轮询。读不到服务/还没配好就静默置空，不当作红色错误。
  async function reloadServerTasks() {
    try {
      const result = await call<{ tasks: ServerTask[] }>('getTasks')
      setServerTasks(result.tasks || [])
    } catch { /* 服务未就绪：任务中心仅显示扩展本地任务 */ }
  }
  useEffect(() => {
    if (serviceState !== 'ok') { setServerTasks([]); return }
    reloadServerTasks()
    const timer = window.setInterval(reloadServerTasks, 2000)
    return () => window.clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serviceState])

  async function loadConfig() {
    try {
      const config = await call<{
        roots: Record<string, { configured: boolean; resolved?: string }>
        excel?: { configured: boolean; resolved?: string; sheetName?: string }
        mappings?: { platformValues?: Record<string, string[]> }
        captionPolicy?: CaptionPolicy
      }>('getConfig')
      setRoots({ unpublished: config.roots?.unpublished?.resolved, published: config.roots?.published?.resolved, archive: config.roots?.archive?.resolved })
      setRootInputs({ unpublished: config.roots?.unpublished?.resolved || '', published: config.roots?.published?.resolved || '', archive: config.roots?.archive?.resolved || '' })
      setExcel({ planPath: config.excel?.resolved || '', sheetName: config.excel?.sheetName || '' })
      setExcelInputs({ planPath: config.excel?.resolved || '', sheetName: config.excel?.sheetName || '' })
      setPlatformValuesText(formatPlatformValues(config.mappings?.platformValues))
      setCaptionPolicy({ ...DEFAULT_CAPTION_POLICY, ...(config.captionPolicy || {}) })
    } catch (e) { setError(errMessage(e)) }
  }

  useEffect(() => { if (serviceState === 'ok') loadConfig() }, [serviceState])

  async function loadCapabilities() {
    try {
      setCapabilities(await call<CapabilitiesResponse>('getCapabilities'))
    } catch { /* 旧服务未实现该命令时不打扰文章库主流程 */ }
  }

  useEffect(() => { if (serviceState === 'ok') loadCapabilities() }, [serviceState])

  async function saveRoots() {
    setError('')
    try {
      await call('setConfig', {
        unpublished: rootInputs.unpublished.trim(),
        published: rootInputs.published.trim(),
        archive: rootInputs.archive.trim(),
        excelPath: excelInputs.planPath.trim(),
        excelSheet: excelInputs.sheetName.trim(),
        platformValues: parsePlatformValues(platformValuesText),
        captionPolicy,
      })
      setScans({}); setDetail(null); setOpenCap(null); setOfficialPreview(null); setOfficialNote(''); setRegistrationPreview(null); setRegistrationNote(''); setPreflight(null); setPreflightNote(''); setChecklist(null); setChecklistNote('')
      await markPackageIdsStale()
      await loadConfig()
    } catch (e) { setError(errMessage(e)) }
  }

  async function exportTemplate() {
    setError(''); setTemplateNote('')
    try {
      const result = await call<{ template: unknown; excluded: string[] }>('getShareableConfigTemplate', {})
      setTemplateText(JSON.stringify(result.template, null, 2))
      setTemplateNote(`已生成团队配置模板；已排除 ${result.excluded.join('、')}。`)
    } catch (e) { setError(errMessage(e)) }
  }

  async function importTemplate() {
    setError(''); setTemplateNote('')
    try {
      const template = JSON.parse(templateText || '{}')
      const result = await call<{ notice?: string }>('importShareableConfigTemplate', { template })
      setTemplateNote(result.notice || '团队配置模板已导入。')
      await loadConfig()
    } catch (e) { setError(errMessage(e)) }
  }

  async function scan(root: 'unpublished' | 'published') {
    setError(''); setScanning(root); setDetail(null); setDetailError(''); setOpenCap(null); setOfficialPreview(null); setOfficialNote(''); setRegistrationPreview(null); setRegistrationNote(''); setPreflight(null); setPreflightNote(''); setChecklist(null); setChecklistNote('')
    try {
      const result = await call<{ packages: PkgSummary[] }>('scan', { root })
      setScans((prev) => ({ ...prev, [root]: result.packages }))
    } catch (e) { setError(errMessage(e)) }
    finally { setScanning('') }
  }

  async function openPackage(pkg: PkgSummary) {
    if (!pkg.packageId) return
    setDetail(null); setDetailError(''); setOfficialPreview(null); setOfficialNote(''); setRegistrationPreview(null); setRegistrationNote(''); setPreflight(null); setPreflightNote(''); setChecklist(null); setChecklistNote('')
    try {
      const currentCapabilities = capabilities || { phase: 'compatibility', realActionsEnabled: false, requirementsBeforeRealActions: [], platforms: FALLBACK_PLATFORM_CAPABILITIES }
      setOpenCap(capabilityFor(pkg.segments, currentCapabilities.platforms))
      setDetail(await call<PkgDetail>('getPackage', { packageId: pkg.packageId }))
    } catch (e) {
      setDetailError(errMessage(e))
      await markPackageIdsStale()
      setTasks(await refreshTasks())
    }
  }

  async function pair() {
    setError('')
    await setToken(tokenInput)
    tokenInput && setTokenInput('')
    try {
      await health()
      await call('getConfig')
      setServiceState('ok')
    } catch (e) {
      setError(errMessage(e))
      if (e instanceof ServiceAuthError) setServiceState('unpaired')
    }
  }

  // 官网/百家号：生成执行预览 + 发送快照（不创建任务、不启动执行器）。
  async function prepareOfficial() {
    if (!detail || !openCap?.siteKey) return
    setError(''); setDetailError(''); setOfficialNote(''); setOfficialBusy('prepare')
    try {
      const result = await call<OfficialPreview>('prepareOfficialTask', { packageId: detail.packageId, siteKey: openCap.siteKey })
      setOfficialPreview(result)
      const gate = result.preview.gate
      setOfficialNote(gate.executable
        ? `执行预览已生成（任务键与内容版本见下）。可继续「模拟运行发布流程」；终态为等待用户最终提交，不会自动发布。`
        : `执行预览已生成，但发送快照存在 ${gate.blocks.length} 项阻塞：模拟流程将不会创建任务。请先解决后再试。`)
    } catch (e) {
      setDetailError(errMessage(e))
    } finally { setOfficialBusy('') }
  }

  // 官网/百家号：模拟状态机（幂等创建任务，绝无真实请求）。
  async function simulateOfficial() {
    if (!detail || !openCap?.siteKey) return
    setError(''); setDetailError(''); setOfficialNote(''); setOfficialBusy('simulate')
    try {
      const result = await call<SimOfficialResponse>('simulateOfficialTask', { packageId: detail.packageId, siteKey: openCap.siteKey })
      await reloadServerTasks()
      if (result.mode === 'blocked') {
        const blocks = result.gate?.blocks || []
        setOfficialNote(`未创建模拟任务（${result.reason || 'gate-blocked'}）${blocks.length ? '：' + blocks.join('；') : ''}`)
        return
      }
      if (result.started && result.task) {
        setTasks(await refreshTasks()); setTab('tasks'); return
      }
      if (result.reason === 'exists') { setTab('tasks'); return }
      if (result.reason === 'stalled') { setOfficialNote('该发布包此前有任务在「结果待核对（重启中断）」。为避免自动重发，请在任务中心清除该任务后再重新模拟。'); return }
      if (result.reason === 'site-lock-busy') { setOfficialNote('站点锁被占用：另一个遵循同一锁协议的新服务进程可能正处理该站点。稍等后重试；该锁不覆盖未接入本协议的旧助手。'); return }
      if (result.reason === 'account-busy') { setOfficialNote('该占位账号已有进行中的任务，请稍候或先在任务中心处理。'); return }
      setOfficialNote(result.detail || result.reason || '未创建模拟任务')
    } catch (e) {
      setDetailError(errMessage(e))
    } finally { setOfficialBusy('') }
  }

  async function previewExcelRegistration() {
    if (!detail || !openCap?.siteKey) return
    setError(''); setDetailError(''); setRegistrationNote(''); setRegistrationBusy(true)
    try {
      const result = await call<ExcelRegistrationPreview>('previewExcelRegistration', { packageId: detail.packageId, siteKey: openCap.siteKey })
      setRegistrationPreview(result)
      const resolution = result.registration?.resolution
      if (!result.registration?.ok) {
        setRegistrationNote(result.registration?.error || '台账预览失败，但未写入任何内容。')
      } else if (resolution?.kind === 'unique') {
        setRegistrationNote(`只读预览：将匹配到第 ${(resolution.matched?.index ?? 0) + 1} 行，尚未写入 Excel。`)
      } else if (resolution?.kind === 'append') {
        setRegistrationNote('只读预览：当前 0 行匹配，已生成拟追加行预览，尚未写入 Excel。')
      } else {
        setRegistrationNote(resolution?.notice || '只读预览完成，需要人工确认后才能进入真实登记阶段。')
      }
    } catch (e) {
      setDetailError(errMessage(e))
    } finally { setRegistrationBusy(false) }
  }

  async function runPreflight() {
    if (!detail || !openCap?.siteKey) return
    setError(''); setDetailError(''); setPreflightNote(''); setPreflightBusy(true)
    try {
      const result = await call<PreflightResponse>('preflightPackage', { packageId: detail.packageId, siteKey: openCap.siteKey })
      setPreflight(result)
      setPreflightNote(result.summary.blocks.length
        ? `预演发现 ${result.summary.blocks.length} 项阻塞，请先修复。`
        : '发布前总预演完成：只读通过；真实动作仍需单独授权。')
    } catch (e) {
      setDetailError(errMessage(e))
    } finally { setPreflightBusy(false) }
  }

  async function generateChecklist() {
    const platformKey = openCap?.siteKey || openCap?.platform?.id
    if (!detail || !platformKey) return
    setError(''); setDetailError(''); setChecklistNote(''); setChecklistBusy(true)
    try {
      const payload = openCap?.siteKey
        ? { packageId: detail.packageId, siteKey: platformKey }
        : { packageId: detail.packageId, platform: platformKey }
      const result = await call<RealExecutionChecklist>('generateRealExecutionChecklist', payload)
      setChecklist(result)
      setChecklistNote(`验收材料已生成：${result.summary.allowedRealActions} 项允许，${result.summary.closedRealActions} 项关闭；未执行任何真实动作。`)
    } catch (e) {
      setDetailError(errMessage(e))
    } finally { setChecklistBusy(false) }
  }

  async function copyChecklistMaterials() {
    if (!checklist) return
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard-api-unavailable')
      await navigator.clipboard.writeText(checklist.exportMarkdown)
      setChecklistNote('完整验收材料已复制，可粘贴到记事本或交付记录中。')
    } catch {
      const helper = document.createElement('textarea')
      helper.value = checklist.exportMarkdown
      helper.setAttribute('readonly', '')
      helper.style.position = 'fixed'
      helper.style.opacity = '0'
      document.body.appendChild(helper)
      helper.select()
      const copied = document.execCommand('copy')
      helper.remove()
      setChecklistNote(copied ? '完整验收材料已复制，可粘贴到记事本或交付记录中。' : '浏览器未允许自动复制，请在下方文本框中全选复制。')
    }
  }

  function downloadChecklistMaterials() {
    if (!checklist) return
    const safeName = checklist.exportFileName.replace(/[^a-z0-9._-]/gi, '_') || 'yizao-acceptance-materials.md'
    const blob = new Blob([checklist.exportMarkdown], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = safeName
    document.body.appendChild(link)
    link.click()
    link.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 0)
    setChecklistNote(`验收材料已下载：${safeName}。该操作不会修改文章目录。`)
  }

  // 知乎/搜狐：草稿流程模拟（扩展本地，不调用平台）。
  async function runDraftSimulation() {
    if (!detail || !openCap?.platform) return
    await createSimulatedTask({
      packageId: detail.packageId, title: detail.title || detail.relativePath, root: detail.root, relativePath: detail.relativePath,
      platform: openCap.platform.id, platformName: openCap.platform.name, imageCount: detail.images.length,
      validationIssueCount: detail.issues.length + (preview?.missing.length || 0) + detail.images.filter((img) => img.error).length,
    })
    setTasks(await refreshTasks()); setTab('tasks')
  }

  async function confirmServerPublished(taskId: string) {
    setError('')
    try {
      await call('confirmPublishedSimulated', { taskId, publicUrl: (publishLinks[taskId] || '').trim() })
      await reloadServerTasks()
    } catch (e) { setError(errMessage(e)) }
  }

  async function confirmLocalPublished(id: string) {
    setError('')
    try {
      await confirmLocalPublishedSimulated(id, (publishLinks[id] || '').trim())
      setTasks(await refreshTasks())
    } catch (e) { setError(errMessage(e)) }
  }

  async function confirmServerExcelRegistered(task: ServerTask) {
    setError('')
    try {
      await call('confirmExcelRegisteredSimulated', {
        taskId: task.taskId,
        sheetName: excel.sheetName || '',
        rowIndex: '',
        plTaskId: '',
        note: '工作台模拟确认登记；未写入真实 Excel。',
      })
      await reloadServerTasks()
    } catch (e) { setError(errMessage(e)) }
  }

  async function confirmLocalExcelRegistered(task: SimTask) {
    setError('')
    try {
      await confirmLocalExcelRegisteredSimulated(task.id, `工作台模拟确认登记；未写入真实 Excel。${excel.sheetName ? `工作表：${excel.sheetName}` : ''}`)
      setTasks(await refreshTasks())
    } catch (e) { setError(errMessage(e)) }
  }

  async function confirmServerArchived(task: ServerTask) {
    setError('')
    try {
      await call('confirmArchivedSimulated', {
        taskId: task.taskId,
        targetPreview: roots.archive ? `${roots.archive}\\${task.relativePath.replace(/\//g, '\\')}` : '',
        note: '工作台模拟确认归档；未移动、复制或删除真实文件。',
      })
      await reloadServerTasks()
    } catch (e) { setError(errMessage(e)) }
  }

  async function confirmLocalArchived(task: SimTask) {
    setError('')
    try {
      await confirmLocalArchivedSimulated(task.id, `工作台模拟确认归档；未移动、复制或删除真实文件。${roots.archive ? `目标预览：${roots.archive}\\${task.relativePath.replace(/\//g, '\\')}` : ''}`)
      setTasks(await refreshTasks())
    } catch (e) { setError(errMessage(e)) }
  }

  async function removeServerTask(taskId: string) {
    setError('')
    try {
      await call('removeTask', { taskId })
      await reloadServerTasks()
    } catch (e) { setError(errMessage(e)) }
  }

  async function runRealActionGateCheck() {
    setError(''); setGateBusy(true)
    try {
      const caps = capabilities || await call<CapabilitiesResponse>('getCapabilities')
      setCapabilities(caps)
      const actions = Object.keys(caps.actions || {
        upload: '真实上传/保存草稿',
        publish: '公开发布',
        excelWrite: 'Excel 写入登记',
        archiveMove: '移动/归档文章包',
      })
      const platforms = caps.platforms.map((p) => p.id)
      const checks = await Promise.all(platforms.flatMap((platform) => actions.map((action) =>
        call<RealActionGateCheck>('checkRealActionGate', { action, platform }))))
      setGateChecks(checks)
    } catch (e) { setError(errMessage(e)) }
    finally { setGateBusy(false) }
  }

  const preview = useMemo(() => detail ? buildPreview(detail) : null, [detail])

  return <main>
    <header>
      <div>
        <small>YIZAO PUBLISH WORKBENCH · 阶段2J（只读 + 模拟，无真实执行）</small>
        <h1>易造发布助手 · 工作台</h1>
        <p data-state={serviceState}>
          {serviceState === 'checking' && '正在检查本地服务…'}
          {serviceState === 'ok' && `本地服务已连接${roots.unpublished ? '' : '，尚未配置目录'}`}
          {serviceState === 'unreachable' && '本地服务未启动（node server.mjs）'}
          {serviceState === 'unpaired' && '本地服务已启动，等待配对'}
        </p>
      </div>
      <nav>
        <button className={tab === 'library' ? 'on' : ''} onClick={() => setTab('library')}>文章库</button>
        <button className={tab === 'platforms' ? 'on' : ''} onClick={() => { setTab('platforms'); loadCapabilities() }}>平台与账号</button>
        <button className={tab === 'safety' ? 'on' : ''} onClick={() => { setTab('safety'); loadCapabilities() }}>安全闸门</button>
        <button className={tab === 'tasks' ? 'on' : ''} onClick={() => setTab('tasks')}>任务中心（{tasks.length + serverTasks.length}）</button>
      </nav>
    </header>

    {serviceState === 'unpaired' && <section className="pair card">
      <h2>服务配对</h2>
      <p className="hint">复制本地服务控制台打印的 64 位令牌粘贴到此处。令牌只保存在本扩展，不会出现在网址或日志里。</p>
      <div className="row">
        <input value={tokenInput} onChange={(e) => setTokenInput(e.target.value)} placeholder="粘贴配对令牌（64 位十六进制）" spellCheck={false} />
        <button onClick={pair} disabled={!/^[0-9a-f]{64}$/i.test(tokenInput.trim())}>配对</button>
      </div>
    </section>}

    {error && <div role="alert" className="error">{error}</div>}

    {serviceState === 'ok' && tab === 'library' && <>
      <section className="card">
        <h2>配置向导（首次使用）</h2>
        <div className="wizard-step">
          <h3>1. 个人目录</h3>
          <div className="row"><label>未发布目录<input value={rootInputs.unpublished} onChange={(e) => setRootInputs({ ...rootInputs, unpublished: e.target.value })} placeholder="例如 C:\Users\你\Desktop\每日文章\未发布" /></label></div>
          <div className="row"><label>已发布历史目录<input value={rootInputs.published} onChange={(e) => setRootInputs({ ...rootInputs, published: e.target.value })} placeholder="留空表示暂不扫描已发布目录" /></label></div>
          <div className="row"><label>归档目标目录（仅预演，不移动文件）<input value={rootInputs.archive} onChange={(e) => setRootInputs({ ...rootInputs, archive: e.target.value })} placeholder="例如 C:\Users\你\Desktop\每日文章\已归档" /></label></div>
          <p className="hint">三个目录不能相同或互相嵌套；服务端会按真实路径复核 junction/符号链接边界。</p>
        </div>
        <div className="wizard-step">
          <h3>2. 登记表 Excel</h3>
          <div className="row"><label>登记表 Excel（只保存路径，不写表）<input value={excelInputs.planPath} onChange={(e) => setExcelInputs({ ...excelInputs, planPath: e.target.value })} placeholder="例如 C:\Users\你\Desktop\计划表\2026年9-11月平台文章执行计划.xlsx" /></label></div>
          <div className="row"><label>默认工作表名（可选）<input value={excelInputs.sheetName} onChange={(e) => setExcelInputs({ ...excelInputs, sheetName: e.target.value })} placeholder="例如 9月执行计划" /></label></div>
        </div>
        <div className="wizard-step">
          <h3>3. 平台字段映射</h3>
          <p className="hint">一行一个平台：左边是助手内部平台，右边是 Excel 里可能出现的写法。例：eyzao.com = 官网，eyzao.com，www.eyzao.com</p>
          <textarea value={platformValuesText} onChange={(e) => setPlatformValuesText(e.target.value)} spellCheck={false} rows={7} />
        </div>
        <div className="wizard-step">
          <h3>4. 图片图注策略</h3>
          <div className="policy-grid">
            <label>官网
              <select value={captionPolicy.official} onChange={(e) => setCaptionPolicy({ ...captionPolicy, official: e.target.value as CaptionPolicy['official'] })}>
                <option value="keep-existing-only">只保留正文已有图注</option>
                <option value="use-existing-alt-after-preview">预览确认后可用已有 ALT 补图注</option>
                <option value="disabled">不追加图注</option>
              </select>
            </label>
            <label>百家号
              <select value={captionPolicy.baijiahao} onChange={(e) => setCaptionPolicy({ ...captionPolicy, baijiahao: e.target.value as CaptionPolicy['baijiahao'] })}>
                <option value="keep-existing-only">只保留正文已有图注</option>
                <option value="use-existing-alt-after-preview">预览确认后可用已有 ALT 补图注</option>
                <option value="disabled">不追加图注</option>
              </select>
            </label>
            <label>知乎/搜狐等草稿平台
              <select value={captionPolicy.draft} onChange={(e) => setCaptionPolicy({ ...captionPolicy, draft: e.target.value as CaptionPolicy['draft'] })}>
                <option value="use-existing-alt-after-preview">预览确认后可用已有 ALT 补图注</option>
                <option value="keep-existing-only">只保留正文已有图注</option>
                <option value="disabled">不追加图注</option>
              </select>
            </label>
          </div>
          <p className="hint">这些策略只保存规则，不生成新文案；图注只能来自正文已有内容或已有 ALT，并且真实执行仍需下一阶段另行授权。</p>
        </div>
        <div className="wizard-step">
          <h3>5. 团队配置模板</h3>
          <div className="row">
            <button type="button" onClick={exportTemplate}>生成可分享模板</button>
            <button type="button" onClick={importTemplate} disabled={!templateText.trim()}>导入模板规则</button>
            {templateNote && <span className="hint">{templateNote}</span>}
          </div>
          <textarea value={templateText} onChange={(e) => setTemplateText(e.target.value)} spellCheck={false} rows={6} placeholder="这里会显示可分享模板；不包含个人目录、Excel 文件路径、令牌、任务历史或日志。" />
        </div>
        <div className="row">
          <button onClick={saveRoots}>保存配置</button>
          <span className="hint">只登记配置用于扫描和预演；不创建、不改名、不移动文件夹，不读取或写入真实 Excel。</span>
        </div>
        {roots.unpublished && <p className="hint">当前未发布目录：{roots.unpublished}{roots.published ? ` · 已发布目录：${roots.published}` : ''}{roots.archive ? ` · 归档目标：${roots.archive}` : ''}</p>}
        {excel.planPath && <p className="hint">当前登记表：{excel.planPath}{excel.sheetName ? ` · 工作表：${excel.sheetName}` : ''}（可做只读匹配预览，不写表）</p>}
      </section>

      {roots.unpublished && <section className="card">
        <h2>文章库</h2>
        <div className="row">
          <button disabled={!!scanning} onClick={() => scan('unpublished')}>{scanning === 'unpublished' ? '扫描中…' : '扫描未发布'}</button>
          {roots.published && <button disabled={!!scanning} onClick={() => scan('published')}>{scanning === 'published' ? '扫描中…' : '扫描已发布'}</button>}
          <span className="hint">只读扫描：识别结果原样展示，不修改任何文件。能力标签：<em className="tag">只读</em> 仅查看不改写；<em className="tag">模拟</em> 不调用真实平台；<em className="tag">待适配</em> 未接入；<em className="tag">需要另行授权</em> 真实发布/投稿需授权。</span>
        </div>
        {(['unpublished', 'published'] as const).filter((r) => scans[r]?.length).map((root) => <div key={root} className="library-state">
          <h3 className="state-title">{root === 'unpublished' ? '未发布' : '已发布（历史待核对）'}</h3>
          {groupPackages(scans[root]!, capabilities?.platforms || FALLBACK_PLATFORM_CAPABILITIES).map((source) => <section className="source-group" key={source.key}>
            <div className="source-head">
              <strong>{source.name}</strong>
              <span className="source-badge">{source.badge}</span>
              <small>{source.count} 个发布包</small>
            </div>
            {source.categories.map((category) => <div className="category-group" key={`${source.key}/${category.name}`}>
              <div className="category-head">
                <strong>{category.name}</strong>
                <span>产品分类</span>
                <small>{category.packages.length} 个发布包</small>
              </div>
              <div className="cards">{category.packages.map((pkg) => {
                const cap = capabilityFor(pkg.segments, capabilities?.platforms || FALLBACK_PLATFORM_CAPABILITIES)
                const disabled = cap.kind === 'not-ready'
                return <button key={pkg.packageId} className="pkg" data-cap={cap.kind} disabled={disabled} title={disabled ? cap.explain : undefined} onClick={() => openPackage(pkg)}>
                  <span className="pkg-caps">{cap.tags.map((tag) => <i key={tag} className={`tag${tag === '待适配' ? ' warn-tag' : ''}`}>{tag}</i>)}</span>
                  <strong>{pkg.title}</strong>
                  <small>{packageDate(pkg)}</small>
                  <span className="pkg-health">{pkg.issueCount ? `⚠ ${pkg.issueCount} 项问题` : '✓ 完整'} <small>图片 {pkg.imageCount} · ALT {pkg.altCount}</small></span>
                  <span className={`pkg-action${cap.kind === 'not-ready' ? ' off' : ''}`}>{cap.label}</span>
                </button>
              })}</div>
            </div>)}
          </section>)}
          {scans[root]!.filter((p) => !p.packageId).map((notice, index) => <p className="hint" key={`${notice.relativePath}/${index}`}>⚠ {notice.title}</p>)}
        </div>)}
        {scans.unpublished && !scans.unpublished.length && <p className="hint">未发布目录中没有识别到发布包（需要 01-SEO元数据.json / 01-SEO信息.txt / 02-后台一键复制正文.html 或 .docx 标记）。</p>}
      </section>}

      {detail && <section className="card detail">
        <h2>发布包详情（只读）</h2>
        {openCap && <div className="caps-row">{openCap.tags.map((tag) => <span key={tag} className={`tag${tag === '待适配' ? ' warn-tag' : ''}`}>{tag}</span>)}</div>}
        <p className="hint">{detail.root === 'unpublished' ? '未发布' : '已发布'} · {detail.relativePath} · {detail.images.length} 张图片 · ALT 来源：{detail.altSource || '无'}{openCap ? ` · 能力：${openCap.label}` : ''}</p>
        {openCap && <p className="hint">{openCap.explain}</p>}
        {!!detail.issues.length && <div className="warn"><strong>校验问题（{detail.issues.length}）：</strong><ul>{detail.issues.map((i, n) => <li key={n}>{i}</li>)}</ul></div>}
        {!!detail.notes.length && <p className="hint">{detail.notes.join('；')}</p>}
        <div className="detail-grid">
          <div className="preview-pane">
            <h3>正文安全预览（本地清理后渲染，不上传）</h3>
            {!!preview?.missing.length && <p className="warn">预览缺图 {preview.missing.length} 张：{preview.missing.join('、')}</p>}
            {detail.html
              ? <iframe title="正文预览" sandbox="" srcDoc={previewDocument(preview!.html)} />
              : <p className="hint">该包没有可预览的 HTML 正文（例如仅 Word 正文包）。</p>}
            <h3>SEO 信息</h3>
            <table><tbody>{Object.entries(detail.seo).map(([k, v]) => <tr key={k}><th>{k}</th><td>{v}</td></tr>)}</tbody></table>
          </div>
          <div>
            <h3>图片与 ALT 对照</h3>
            <ul className="images">{detail.images.map((img) => <li key={`${img.dir}/${img.name}`}>
              {img.dataUrl ? <img src={img.dataUrl} alt={img.alt} /> : <span className="missing-img">读取失败</span>}
              <div>
                <strong>#{img.number} {img.name}</strong>
                <small>ALT：{img.alt ? img.alt : <em className="warn-inline">（空）</em>}</small>
                {img.duplicateOf && <small className="warn-inline">重复内容：与 {img.duplicateOf} 相同</small>}
                {img.error && <small className="warn-inline">{img.error}</small>}
              </div>
            </li>)}</ul>
            <h3>正文出现位置映射（{detail.occurrences?.length || 0}）</h3>
            <ul className="mapping">{(detail.occurrences || []).map((occ) => <li key={occ.occurrenceId}>
              <strong>第 {occ.position} 处 · {occ.name || '无文件名'}</strong>
              <small>文件：{occ.assetMatch}{occ.assetName ? ` → ${occ.assetDir}/${occ.assetName}` : ''}</small>
              <small>清单 ALT：{occ.manifestAlt || '（空）'}；HTML ALT：{occ.htmlAlt || '（空）'}</small>
              <small>实际采用：{occ.effectiveAlt || '（空）'}{occ.altSource ? `（${occ.altSource}）` : ''}</small>
              <small>可见图注：{occ.caption || '（正文没有显式 figcaption；不自动生成）'}</small>
              {occ.altConflict && <small className="warn-inline">ALT 文案冲突，模拟校验会停止</small>}
            </li>)}</ul>
            <h3>文件清单（{detail.fileList.length}）</h3>
            <ul className="files">{detail.fileList.map((f) => <li key={f.relative}><code>{f.relative}</code> <small>{(f.bytes / 1024).toFixed(1)} KB</small></li>)}</ul>
          </div>
        </div>

        {/* 能力入口：发布流程预览（官网/百家号，服务端）| 草稿流程预览（知乎/搜狐，扩展本地）| 待适配（禁用） */}
        <div className="flow-card">
          {openCap?.kind === 'publish-preview' && <>
            <h3>发布流程预览（{openCap.siteName} · 阶段2J 仅模拟）</h3>
            <p className="hint">目标站点：{openCap.siteName}（{openCap.siteKey}）· 站点锁键：{openCap.siteKey} · 账号占位：{openCap.siteKey}-占位账号（不真实登录）。先「生成执行预览与发送快照」，确认无误后再运行模拟发布流程。</p>
            <div className="row">
              <button onClick={prepareOfficial} disabled={!!officialBusy || !serviceState}>{officialBusy === 'prepare' ? '正在生成…' : '生成执行预览与发送快照'}</button>
              <button className="secondary" onClick={simulateOfficial} disabled={!!officialBusy || !officialPreview}>{officialBusy === 'simulate' ? '正在运行…' : '模拟运行发布流程（等待用户最终提交，绝不自动发布）'}</button>
              <button className="secondary" onClick={runPreflight} disabled={preflightBusy}>{preflightBusy ? '正在预演…' : '发布前总预演（只读）'}</button>
              <button className="secondary" onClick={generateChecklist} disabled={checklistBusy}>{checklistBusy ? '正在生成…' : '生成真实执行验收单（只读）'}</button>
              {officialNote && <span className="hint">{officialNote}</span>}
              {preflightNote && <span className="hint">{preflightNote}</span>}
              {checklistNote && <span className="hint">{checklistNote}</span>}
            </div>
            {officialBusy === 'simulate' && <p className="hint">模拟状态机将在本地服务内分步推进到「等待用户最终提交（模拟）」后停止，耗时约 1 秒；期间不会访问任何真实平台。</p>}
            {officialPreview && <>
              {officialPreview.preview.gate.executable
                ? <p className="ok-line">✓ 发送快照校验通过：{officialPreview.preview.content.title || ''}（图片 {officialPreview.preview.content.imageCount} 张{officialPreview.preview.content.byteCount ? ` · ${(officialPreview.preview.content.byteCount / 1024).toFixed(0)} KB` : ''}）</p>
                : <div className="warn"><strong>发送快照存在阻塞问题（{officialPreview.preview.gate.blocks.length} 项）：</strong>
                  <ul>{(officialPreview.preview.gate.blocks || []).map((b, i) => <li key={i}>{b}</li>)}</ul>
                  <p className="hint">与真实流程一致：阻塞时不会创建任务。请先补齐缺图 / 同名不同文件 / ALT 冲突 / 空 ALT 等校验项再继续。</p></div>}
              <dl className="flow-meta">
                <div><dt>任务键</dt><dd className="mono">{officialPreview.taskKey}</dd></div>
                <div><dt>内容版本</dt><dd className="mono">{officialPreview.snapshot.contentVersionShort}</dd></div>
                <div><dt>发送快照</dt><dd className="mono">{officialPreview.snapshot.snapshotId}</dd></div>
                <div><dt>目标平台 / 账号占位</dt><dd>{officialPreview.preview.platformName} · {officialPreview.preview.account}</dd></div>
                <div><dt>终态动作</dt><dd>{officialPreview.preview.finalAction}</dd></div>
              </dl>
              <p className="hint">正文出现位置 {officialPreview.preview.occurrences.length} 处（ALT 与可见图注永远是两个字段；官网/百家号默认不追加可见图注，只回显正文已有图注）。下方「正文出现位置映射」即为发送快照采用的同一份对照表。</p>
              <ul className="preview-occ">
                {officialPreview.preview.occurrences.slice(0, 6).map((o) => <li key={o.position}>
                  <small>第 {o.position} 处{o.name ? ` · ${o.name}` : ''}：ALT「{o.alt || '（空）'}」{o.caption ? ` · 图注「${o.caption}」` : ' · 无既有图注（不自动生成）'}</small>
                </li>)}
              </ul>
            </>}

            <div className="registration-card">
              <h3>Excel 登记匹配预览（只读，不写表）</h3>
              <p className="hint">读取已配置的登记表，按「PL 任务编号 + 平台」预览将来会匹配哪一行。没有 PL 编号时会提示人工绑定；多行匹配会停止，不猜。</p>
              <div className="row">
                <button className="secondary" onClick={previewExcelRegistration} disabled={registrationBusy || !excel.planPath}>{registrationBusy ? '正在预览…' : '只读预览台账匹配'}</button>
                {!excel.planPath && <span className="hint">请先在上方配置登记表 Excel 路径。</span>}
                {registrationNote && <span className="hint">{registrationNote}</span>}
              </div>
              {registrationPreview && <div className="registration-result">
                <dl className="flow-meta">
                  <div><dt>台账文件</dt><dd className="mono">{registrationPreview.excel.resolved}</dd></div>
                  <div><dt>目标工作表</dt><dd>{registrationPreview.registration.targetSheet || registrationPreview.excel.sheetName || '未命中'}</dd></div>
                  <div><dt>查询任务编号</dt><dd className="mono">{registrationPreview.query.plTaskId || '未识别，需要绑定'}</dd></div>
                  <div><dt>查询平台</dt><dd>{registrationPreview.query.platform || '未识别'}</dd></div>
                  <div><dt>查询标题</dt><dd>{registrationPreview.query.title || '（空）'}</dd></div>
                </dl>
                {!registrationPreview.registration.ok && <div className="warn">{registrationPreview.registration.error}</div>}
                {registrationPreview.registration.ok && registrationPreview.registration.resolution?.kind === 'unique' && <p className="ok-line">✓ 唯一匹配：第 {registrationPreview.registration.resolution.matched!.index + 1} 行 · {registrationPreview.registration.resolution.matched!.title || '（无标题）'} · 状态：{registrationPreview.registration.resolution.matched!.status || '（空）'}</p>}
                {registrationPreview.registration.ok && registrationPreview.registration.resolution?.kind === 'append' && <div className="warn">
                  <strong>0 行匹配，拟追加行预览（未写入）：</strong>
                  <p className="hint">第 {registrationPreview.registration.resolution.appendRow!.index + 1} 行 · {registrationPreview.registration.resolution.appendRow!.taskId} · {registrationPreview.registration.resolution.appendRow!.platform} · {registrationPreview.registration.resolution.appendRow!.category || '（空分类）'} · {registrationPreview.registration.resolution.appendRow!.title || '（空标题）'}</p>
                </div>}
                {registrationPreview.registration.ok && ['conflict', 'needs-binding', 'column-conflict'].includes(registrationPreview.registration.resolution?.kind || '') && <div className="warn">
                  <strong>需要人工确认：</strong>
                  <p className="hint">{registrationPreview.registration.resolution?.notice}</p>
                </div>}
                <p className="hint">{registrationPreview.notice}</p>
              </div>}
            </div>
            {preflight && <div className="preflight-card">
              <h3>发布前总预演（只读）</h3>
              <div className="gate-banner">
                <strong>{preflight.summary.blocks.length ? `有 ${preflight.summary.blocks.length} 项阻塞` : '预演可读通过'}</strong>
                <span>{preflight.summary.executableInThisBuild ? '可执行' : '真实动作未启用'}</span>
                <small>{preflight.notice}</small>
              </div>
              {!!preflight.summary.blocks.length && <div className="warn"><strong>阻塞项：</strong><ul>{preflight.summary.blocks.map((b, i) => <li key={i}>{b}</li>)}</ul></div>}
              {!!preflight.summary.warnings.length && <div className="warn"><strong>提醒：</strong><ul>{preflight.summary.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul></div>}
              <dl className="flow-meta">
                <div><dt>文章包</dt><dd>{preflight.package.title}</dd></div>
                <div><dt>目标平台</dt><dd>{preflight.snapshot?.platformName || preflight.platform.requested}</dd></div>
                <div><dt>图片/出现位置</dt><dd>{preflight.snapshot ? `${preflight.snapshot.imageCount} 张 / ${preflight.snapshot.occurrenceCount} 处` : '未生成快照'}</dd></div>
                <div><dt>Excel 匹配</dt><dd>{preflight.registration.configured ? preflight.registration.status : '未配置'}</dd></div>
                <div><dt>归档目标</dt><dd className="mono">{preflight.archive.targetPreview || preflight.archive.notice}</dd></div>
                <div><dt>下一步</dt><dd>{preflight.summary.nextStep}</dd></div>
              </dl>
              <div className="gate-list">
                {Object.entries(preflight.gates).map(([key, gate]) => <small key={key}>真实{gate.actionName}：{gate.allowed ? '允许' : '关闭'}（{gate.policy}）</small>)}
              </div>
            </div>}
          </>}

          {openCap?.kind === 'draft-preview' && <>
            <h3>草稿流程预览（{openCap.platform?.name} · 扩展本地模拟）</h3>
            <p className="hint">模拟状态：校验发布包 → 模拟上传图片 → 模拟保存草稿 → 终态「模拟完成（未保存草稿）」。不调用「{openCap.platform?.name}」任何真实接口；保存草稿 ≠ 已发布，不会登记 Excel，也不移动文件。</p>
            <div className="row">
              <button onClick={runDraftSimulation}>创建模拟草稿任务（不调用平台接口）</button>
              <button className="secondary" onClick={generateChecklist} disabled={checklistBusy}>{checklistBusy ? '正在生成…' : '生成小样本验收材料（只读）'}</button>
              <span className="hint">目标账号：占位（真实投稿需要另行授权）。</span>
            </div>
          </>}

          {openCap?.kind === 'not-ready' && <>
            <h3>待适配</h3>
            <p className="hint">{openCap.explain}</p>
          </>}

          {checklist && <div className="checklist-card">
            <h3>真实执行验收材料（只读预览）</h3>
            <div className="gate-banner">
              <strong>{checklist.summary.executableInThisBuild ? '可进入真实执行' : '不可真实执行'}</strong>
              <span>{checklist.summary.allowedRealActions} 项允许 / {checklist.summary.closedRealActions} 项关闭</span>
              <small>{checklist.notice}</small>
            </div>
            <div className="row">
              <button className="secondary" onClick={copyChecklistMaterials}>复制完整验收材料</button>
              <button className="secondary" onClick={downloadChecklistMaterials}>下载 Markdown</button>
              <span className="hint">下载只保存验收文本，不会修改文章包。</span>
            </div>
            <label className="checklist-section"><strong>真实执行验收单</strong>
              <textarea value={checklist.checklistMarkdown} readOnly rows={14} spellCheck={false} />
            </label>
            <label className="checklist-section"><strong>单篇小样本验收模板</strong>
              <textarea value={checklist.acceptanceTemplateMarkdown} readOnly rows={18} spellCheck={false} />
            </label>
            <p className="hint">这些只是可复制、可下载的只读验收文本，不是执行授权；不能据此自动上传、写表或归档。</p>
          </div>}
        </div>
      </section>}
      {detailError && <div role="alert" className="error">{detailError}</div>}
    </>}

    {tab === 'platforms' && <section className="card">
      <h2>平台与账号 · 能力状态</h2>
      <p className="hint">这里先做“最终版安全骨架”：列清哪些平台可模拟、哪些仅草稿模拟、哪些待适配；真实上传/公开发布/写表/归档当前统一关闭，后续逐平台验收后再开放。</p>
      {!capabilities && <p className="hint">本地服务暂未返回能力表。请确认服务已更新并重新配对。</p>}
      {capabilities && <>
        <div className="gate-banner">
          <strong>{capabilities.realActionsEnabled ? '真实动作已启用' : '真实动作未启用'}</strong>
          <span>{capabilities.phase}</span>
          <small>当前工作台仍不会调用真实账号、写 Excel 或移动文件。</small>
        </div>
        <h3>进入真实阶段前必须满足</h3>
        <ul className="checklist">{capabilities.requirementsBeforeRealActions.map((item) => <li key={item}>{item}</li>)}</ul>
        <div className="cap-grid">{capabilities.platforms.map((p) => <article className="cap-card" data-status={p.status} key={p.id}>
          <div className="cap-head">
            <strong>{p.name}</strong>
            <span>{p.group}</span>
          </div>
          <p className="cap-status">
            {p.status === 'simulation-ready' && '可做发布流程模拟'}
            {p.status === 'draft-simulation' && '可做草稿流程模拟'}
            {p.status === 'not-adapted' && '待适配'}
            {!['simulation-ready', 'draft-simulation', 'not-adapted'].includes(p.status) && p.status}
          </p>
          <small>当前：{p.currentActions.join('、')}</small>
          <small>计划：{p.plannedActions.join('、')}</small>
          {!!p.evidence?.length && <small>依据：{p.evidence.join('；')}</small>}
          {!!p.risks?.length && <small className="warn-inline">风险：{p.risks.join('；')}</small>}
        </article>)}</div>
      </>}
    </section>}

    {tab === 'safety' && <section className="card">
      <h2>安全闸门 · 真实动作检查（阶段2J）</h2>
      <p className="hint">这是进入真实阶段前的“刹车盘”：只检查规则，不执行任何上传、公开发布、Excel 写入或文件归档。当前版本预期结果应为全部关闭或不支持。</p>
      {!capabilities && <p className="hint">本地服务暂未返回能力表。请确认服务已启动并完成配对。</p>}
      {capabilities && <>
        <div className="gate-banner">
          <strong>{capabilities.realActionsEnabled ? '真实动作已启用' : '真实动作未启用'}</strong>
          <span>{capabilities.phase}</span>
          <small>本页按钮只调用 checkRealActionGate，不会调用真实执行器。</small>
        </div>
        <h3>真实阶段前置条件</h3>
        <ul className="checklist">{capabilities.requirementsBeforeRealActions.map((item) => <li key={item}>{item}</li>)}</ul>
        <div className="row">
          <button onClick={runRealActionGateCheck} disabled={gateBusy}>{gateBusy ? '正在检查…' : '检查真实动作闸门（只读）'}</button>
          <span className="hint">检查范围：{capabilities.platforms.length} 个平台 × {Object.keys(capabilities.actions || {}).length || 4} 类真实动作。</span>
        </div>
        {!!gateChecks.length && <div className="gate-table-wrap">
          <table className="gate-table">
            <thead><tr><th>平台</th><th>真实动作</th><th>结果</th><th>策略</th><th>原因</th></tr></thead>
            <tbody>{gateChecks.map((gate) => <tr key={`${gate.platform}/${gate.action}`} data-allowed={gate.allowed ? 'yes' : 'no'}>
              <td>{gate.platformName}</td>
              <td>{gate.actionName}</td>
              <td>{gate.allowed ? '允许' : '关闭'}</td>
              <td>{gate.policy}</td>
              <td>{gate.reason}</td>
            </tr>)}</tbody>
          </table>
          <p className="hint">复核结果：{gateChecks.filter((gate) => gate.allowed).length} 项允许，{gateChecks.filter((gate) => !gate.allowed).length} 项关闭。只要仍有真实动作关闭，本工作台就不能进入真实执行。</p>
        </div>}
      </>}
    </section>}

    {tab === 'tasks' && <section className="card">
      <h2>任务中心 · 模拟（阶段2J）</h2>
      <p className="hint">以下任务均为本地模拟：官网/百家号为本地服务内任务（真实发布需另行授权），知乎/搜狐为扩展本地草稿模拟，均未调用真实平台。四段状态按顺序展示：流程/草稿 → 人工确认发布 → 人工确认登记 → 人工确认归档。</p>

      <h3 className="state-title">按发布包汇总 · 归档门槛预览</h3>
      {!archiveGroups.length && <p className="hint">暂无可汇总的任务。创建模拟任务后，这里会按发布包显示是否允许归档。</p>}
      {!!archiveGroups.length && <div className="archive-groups">{archiveGroups.map((group) => <article className="archive-group" data-state={group.state} key={group.packageId}>
        <div className="archive-head">
          <strong>{group.title}</strong>
          <span>{group.stateLabel}</span>
        </div>
        <small className="mono">{group.relativePath}</small>
        <div className="archive-lines">{group.lines.map((line) => <div className="archive-line" key={line.key}>
          <strong>{line.platformName}</strong>
          <span>发布：{line.publishStatus}</span>
          <span>登记：{line.excelStatus}</span>
          <span>归档：{line.archiveStatus}</span>
        </div>)}</div>
        {!group.ready && <ul className="checklist">{group.reasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul>}
        <p className="hint">只读门槛：不会移动源文件。草稿、模拟完成、等待用户最终提交都不算正式发布；一个包供多个平台使用时，必须全部人工确认发布且登记后，才允许进入归档确认。</p>
      </article>)}</div>}

      {serviceState === 'ok' && serverTasks.length > 0 && <>
        <h3 className="state-title">官网 / 百家号 · 服务端模拟任务</h3>
        <ul className="tasks">{serverTasks.map((t) => <li key={t.taskId}>
          <div className="task-head">
            <strong>{t.title}</strong>
            <span className="badge sim">模拟</span>
            <span className="badge">{t.platformName || t.platform}</span>
            <small>{t.accountLabel || t.accountId}</small>
            <small className="mono">内容版本 {t.contentVersionShort}</small>
            <button className="danger" onClick={() => removeServerTask(t.taskId)}>删除</button>
          </div>
          <div className="task-meta">任务键 <code>{t.taskKey}</code> · 发送快照 {t.snapshotId} · 创建 {fmtTime(t.createdAt)}</div>
          <div className="task-steps">{taskSteps({ draft: t.draft.stage || '未执行', publish: t.publish?.status || '未发布', excel: t.excel?.status || '未登记', archive: t.archive?.status || '未归档' }).map((step) => <div className="task-step" data-state={step.state} key={step.key}>
            <span>{step.label}</span>
            <strong>{step.value}</strong>
          </div>)}</div>
          <div className="confirm-row" aria-label="模拟确认操作">
            <input value={publishLinks[t.taskId] || ''} onChange={(e) => setPublishLinks({ ...publishLinks, [t.taskId]: e.target.value })} placeholder="正式链接（模拟，可留空）" />
            <button className="secondary" disabled={t.publish?.status === '人工确认已发布'} onClick={() => confirmServerPublished(t.taskId)}>{t.publish?.status === '人工确认已发布' ? '已模拟确认发布' : '模拟确认已发布'}</button>
            <button className="secondary" disabled={t.publish?.status !== '人工确认已发布' || t.excel?.status === '已登记'} onClick={() => confirmServerExcelRegistered(t)}>{t.excel?.status === '已登记' ? '已模拟登记' : (t.publish?.status === '人工确认已发布' ? '模拟确认已登记' : '需先确认发布')}</button>
            <button className="secondary" disabled={t.publish?.status !== '人工确认已发布' || t.excel?.status !== '已登记' || t.archive?.status === '已归档'} onClick={() => confirmServerArchived(t)}>{t.archive?.status === '已归档' ? '已模拟归档' : (t.excel?.status === '已登记' ? '模拟确认已归档' : '需先登记')}</button>
          </div>
          <small>{t.draft.detail}</small>
          {t.publish?.detail && <small>{t.publish.detail}</small>}
          {t.excel?.detail && <small>{t.excel.detail}</small>}
          {t.archive?.detail && <small>{t.archive.detail}</small>}
          <div className="task-detail">
            <small>目标平台：{t.platformName || t.platform} · 账号占位：{t.accountLabel || t.accountId}</small>
            <small>最后更新时间：{fmtTime(t.updatedAt)}</small>
            <small>相对路径：{t.relativePath}</small>
          </div>
        </li>)}</ul>
      </>}
      {serviceState === 'ok' && serverTasks.length === 0 && <p className="hint">暂无官网/百家号服务端模拟任务。</p>}

      <h3 className="state-title">知乎 / 搜狐 · 扩展本地草稿模拟</h3>
      {!tasks.length && <p className="hint">暂无草稿模拟任务。请在文章库打开发布包后创建。</p>}
      <ul className="tasks">{tasks.map((t) => <li key={t.id}>
        <div className="task-head">
          <strong>{t.title}</strong>
          <span className="badge sim">模拟</span>
          <span className="badge">{t.platformName}</span>
          <small>{new Date(t.createdAt).toLocaleString()}</small>
          <button className="danger" onClick={async () => { await removeSimTask(t.id); setTasks(await refreshTasks()) }}>删除</button>
        </div>
        <div className="task-steps">{taskSteps({ draft: t.draft.stage, publish: t.publish, excel: t.register, archive: t.archive }).map((step) => <div className="task-step" data-state={step.state} key={step.key}>
          <span>{step.label}</span>
          <strong>{step.value}</strong>
        </div>)}</div>
        <div className="confirm-row" aria-label="模拟确认操作">
          <input value={publishLinks[t.id] || ''} onChange={(e) => setPublishLinks({ ...publishLinks, [t.id]: e.target.value })} placeholder="正式链接（模拟，可留空）" />
          <button className="secondary" disabled={t.publish === '人工确认已发布'} onClick={() => confirmLocalPublished(t.id)}>{t.publish === '人工确认已发布' ? '已模拟确认发布' : '模拟确认已发布'}</button>
          <button className="secondary" disabled={t.publish !== '人工确认已发布' || t.register === '已登记'} onClick={() => confirmLocalExcelRegistered(t)}>{t.register === '已登记' ? '已模拟登记' : (t.publish === '人工确认已发布' ? '模拟确认已登记' : '需先确认发布')}</button>
          <button className="secondary" disabled={t.publish !== '人工确认已发布' || t.register !== '已登记' || t.archive === '已归档'} onClick={() => confirmLocalArchived(t)}>{t.archive === '已归档' ? '已模拟归档' : (t.register === '已登记' ? '模拟确认已归档' : '需先登记')}</button>
        </div>
        <small>{t.draft.detail}</small>
        {t.registerDetail && <small>{t.registerDetail}</small>}
        {t.archiveDetail && <small>{t.archiveDetail}</small>}
        <div className="task-detail">
          <small>能力：草稿流程预览（{t.platformName}）· 目标账号：占位（需要另行授权）</small>
          <small>最后更新时间：{new Date(t.updatedAt).toLocaleString()}</small>
        </div>
        {t.packageIdStale && <small className="warn-inline">包 ID 已失效（服务重启或目录重新配置），仅保留历史记录。</small>}
      </li>)}</ul>
    </section>}

    <footer>
      <p>阶段2J 只读 + 模拟：不上传文章、不公开发布、不写真实 Excel、不移动文件、不启动旧执行器。官网/百家号模拟在本地服务内推进，终态「等待用户最终提交」；任务中心以步骤条展示人工确认发布、登记与归档结果；安全闸门、真实执行验收单和单篇小样本模板只读生成，不代表授权执行。</p>
      <p>能力标签说明：<em className="tag">只读</em> 仅查看不改写文件；<em className="tag">模拟</em> 不调用真实平台接口；<em className="tag">待适配</em> 平台/网站尚未接入；<em className="tag">需要另行授权</em> 真实发布/草稿/归档需单独授权并完成验收。</p>
    </footer>
  </main>
}
