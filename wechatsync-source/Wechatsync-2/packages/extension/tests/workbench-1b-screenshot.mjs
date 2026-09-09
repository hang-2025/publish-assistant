// 阶段1B 工作台自动截图（全部为模拟数据）：仅本地构建产物 + 内存 mock 的 8788 路由。
// 不连接真实服务、不使用真实账号/目录/Excel/文章。截图顶部固定水印「模拟数据」。
// 覆盖：文章库能力标签（官网/百家号=发布流程预览、知乎/搜狐=草稿流程预览、头条=待适配禁用）、
//      官网发布流程预览（任务键/内容版本/目标站点/账号占位/终态动作）、Excel 登记只读预览、
//      任务中心（服务端+扩展本地合并）。
import { chromium } from 'playwright'
import http from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const distRoot = path.join(extensionRoot, 'dist')
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jC1sAAAAASUVORK5CYII='
const iso = '2026-09-04T09:30:00.000Z'
const cv = 'c'.repeat(64)
const cvShort = cv.slice(0, 12)
const taskKey = `pkg-official|eyzao.com|eyzao.com-占位账号|${cv}`

const packages = [
  { packageId: 'pkg-official', relativePath: '官网/eyzao.com/易造新闻/2026-09-01/官网正常包', segments: ['官网', 'eyzao.com', '易造新闻', '2026-09-01', '官网正常包'], title: '易造新品发布通稿（模拟）', imageCount: 1, altCount: 1, issueCount: 0, issues: [], notes: ['模拟发布包，不含真实文章'] },
  { packageId: 'pkg-baijiahao', relativePath: '主流平台/百家号/易造科技/2026-09-02/百家号包', segments: ['主流平台', '百家号', '易造科技', '2026-09-02', '百家号包'], title: '百家号图文（模拟）', imageCount: 1, altCount: 1, issueCount: 0, issues: [], notes: ['模拟发布包，不含真实文章'] },
  { packageId: 'pkg-zhihu', relativePath: '主流平台/zhihu/智能雷暴仪/2026-09-02/知乎包', segments: ['主流平台', 'zhihu', '智能雷暴仪', '2026-09-02', '知乎包'], title: '智能雷暴仪预警应用', imageCount: 1, altCount: 1, issueCount: 0, issues: [], notes: ['模拟发布包，不含真实文章'] },
  { packageId: 'pkg-toutiao', relativePath: '主流平台/toutiao/智能雷暴仪/2026-09-03/头条包', segments: ['主流平台', 'toutiao', '智能雷暴仪', '2026-09-03', '头条包'], title: '雷电预警头条版（待适配）', imageCount: 1, altCount: 1, issueCount: 0, issues: [], notes: ['待适配平台，仅只读展示'] },
  { packageId: 'pkg-netease', relativePath: '主流平台/网易号/智能雷暴仪/2026-09-04/网易包', segments: ['主流平台', '网易号', '智能雷暴仪', '2026-09-04', '网易包'], title: '雷电预警网易版（模拟）', imageCount: 1, altCount: 1, issueCount: 0, issues: [], notes: ['网易草稿流程仅本地模拟'] },
]

function packageDetail(pkg) {
  return {
    packageId: pkg.packageId, root: 'unpublished', relativePath: pkg.relativePath, title: pkg.title,
    seo: { 内容栏目: pkg.segments[2], SEO描述: '阶段1B 模拟数据，未用于真实发布' },
    html: '<p>这是一段用于截图与安全预览的模拟正文。</p><figure><img src="06-发布图片/1-配图.png" alt="模拟配图说明"><figcaption>模拟正文自带图注</figcaption></figure>',
    alts: [{ number: 1, alt: '模拟配图说明' }], altSource: '03-图片ALT清单.txt',
    images: [{ number: 1, name: '1-配图.png', dir: '06-发布图片', bytes: 68, sha256: 'a'.repeat(64), dataUrl: png, alt: '模拟配图说明', altSource: '03-图片ALT清单.txt', duplicateOf: null }],
    occurrences: [{ occurrenceId: 'img-1', position: 1, src: '06-发布图片/1-配图.png', name: '1-配图.png', assetNumber: 1, assetName: '1-配图.png', assetDir: '06-发布图片', assetMatch: '正文文件名唯一匹配', manifestAlt: '模拟配图说明', htmlAlt: '模拟配图说明', effectiveAlt: '模拟配图说明', altSource: '03-图片ALT清单.txt', altConflict: false, caption: '模拟正文自带图注', captionSource: '正文 figcaption' }],
    issues: pkg.issues || [], notes: pkg.notes || [],
    fileList: [{ relative: '02-后台一键复制正文.html', bytes: 256 }, { relative: '06-发布图片/1-配图.png', bytes: 68 }],
  }
}

let serverTask = {
  taskId: 'tsk_1', taskKey, mode: 'simulate', packageId: 'pkg-official', rootName: 'unpublished',
  relativePath: '官网/eyzao.com/易造新闻/2026-09-01/官网正常包',
  platform: 'eyzao.com', platformName: '官网（eyzao.com）', platformKind: 'official',
  accountId: 'eyzao.com-占位账号', accountLabel: 'eyzao.com-占位账号', title: '易造新品发布通稿（模拟）',
  contentVersion: cv, contentVersionShort: cvShort, snapshotId: 'snap-' + '9'.repeat(24), runState: 'terminal',
  draft: { stage: '等待用户最终提交（模拟）', detail: '模拟流程已完成：未上传、未发布、未登记 Excel、未归档。等待人工在站点后台最终提交。', updatedAt: iso },
  publish: { status: '未发布', detail: '模拟：未调用任何真实发布动作', updatedAt: iso },
  excel: { status: '未登记', detail: '阶段1B 不提供 Excel 写入命令', updatedAt: iso },
  archive: { status: '未归档', detail: '阶段1B 不提供真实归档命令', updatedAt: iso },
  createdAt: iso, updatedAt: iso, finishedAt: iso,
}

const officialPreview = {
  mode: 'preview',
  preview: {
    mode: 'preview', simulatedOnly: true, siteKey: 'eyzao.com', siteName: '易造官网（eyzao.com）',
    platform: 'official', platformName: '官网', adapter: 'emcms',
    account: 'eyzao.com-占位账号', accountId: 'eyzao.com-占位账号', lockKey: 'site-eyzao_com',
    note: '仅执行预览：未创建任务、未启动执行器、未打开浏览器、未点击最终发布。',
    gate: { executable: true, blocks: [], warnings: [] },
    contentVersion: cv, contentVersionShort: cvShort,
    content: { title: '易造新品发布通稿（模拟）', imageCount: 1, byteCount: 12345, seoCategory: '易造新闻' },
    category: { seoCategory: '易造新闻', cmsCategory: '易造新闻（模拟栏目映射）', note: '栏目映射为模拟占位表，真实授权后须以站点配置为准。' },
    assets: [{ dir: '06-发布图片', name: '1-配图.png', sha256: 'a'.repeat(64), bytes: 68 }],
    occurrences: [{ position: 1, name: '1-配图.png', asset: '06-发布图片/1-配图.png', alt: '模拟配图说明', altSource: '03-图片ALT清单.txt', altConflict: false, caption: '模拟正文自带图注', captionSource: '正文 figcaption', captionAppended: false }],
    flow: { steps: ['读取发送快照', '模拟填写官网后台', '等待用户最终提交'] },
    finalAction: '等待用户最终提交（模拟）——绝不自动发布', previewOnly: true,
  },
  snapshot: {
    snapshotId: 'snap-' + '9'.repeat(24), gate: { executable: true, blocks: [], warnings: [] },
    contentVersion: cv, contentVersionShort: cvShort,
  },
  taskKey,
}

const registrationPreview = {
  mode: 'excel-registration-preview',
  readOnly: true,
  excel: { configured: true, resolved: 'C:\\模拟目录\\计划表\\阶段1C模拟登记表.xlsx', sheetName: '9月执行计划' },
  query: { plTaskId: 'PL-2026-001', platform: 'eyzao.com', category: '易造新闻', title: '易造新品发布通稿（模拟）', date: '2026-09-01' },
  registration: {
    ok: true,
    readOnly: true,
    sheets: [{ name: '9月执行计划', rows: 2, cols: 7, header: '任务编号 | 平台 | 产品分类 | 文章标题 | 计划日期 | 发布状态 | 正式链接' }],
    targetSheet: '9月执行计划',
    columnMapPreview: { suggested: { taskId: 0, platform: 1, category: 2, title: 3, date: 4, status: 5, link: 6 }, matched: ['taskId', 'platform', 'category', 'title', 'date', 'status', 'link'], unmatched: ['source'], conflicts: [], ok: true },
    resolution: {
      kind: 'unique',
      code: 'ok',
      matched: { index: 1, taskId: 'PL-2026-001', platform: 'eyzao.com', category: '易造新闻', title: '易造新品发布通稿（模拟）', date: '2026-09-01', status: '未发布', link: '' },
      rows: [],
      appendRow: null,
    },
  },
  notice: '只读预览：未写入 Excel、未登记任务、未移动或归档文章包。',
}

const preflight = {
  mode: 'preflight',
  readOnly: true,
  package: { packageId: 'pkg-official', rootName: 'unpublished', relativePath: '官网/eyzao.com/易造新闻/2026-09-01/官网正常包', title: '易造新品发布通稿（模拟）' },
  platform: { requested: 'eyzao.com', siteKey: 'eyzao.com', derived: ['eyzao.com'], reason: 'ok' },
  snapshot: { siteKey: 'eyzao.com', platformName: '官网', account: 'eyzao.com-占位账号', finalAction: '等待用户最终提交（模拟）——绝不自动发布', gate: { executable: true, blocks: [], warnings: [] }, contentVersionShort: cvShort, snapshotId: 'snap-' + '9'.repeat(24), imageCount: 1, occurrenceCount: 1 },
  registration: { configured: true, status: 'unique', query: registrationPreview.query, preview: registrationPreview.registration },
  archive: { configured: true, targetRoot: 'C:\\模拟目录\\已归档', targetPreview: 'C:\\模拟目录\\已归档\\官网\\eyzao.com\\易造新闻\\2026-09-01\\官网正常包', status: 'preview-only', notice: '只读归档预演：未复制、未移动、未删除任何文件。' },
  gates: {
    upload: { allowed: false, actionName: '真实上传/保存草稿', reason: '当前构建是只读/模拟版本', policy: 'requires-explicit-authorization' },
    publish: { allowed: false, actionName: '公开发布', reason: '当前构建是只读/模拟版本', policy: 'manual-final-submit-only' },
    excelWrite: { allowed: false, actionName: 'Excel 写入登记', reason: '当前构建是只读/模拟版本', policy: 'requires-explicit-authorization' },
    archiveMove: { allowed: false, actionName: '移动/归档文章包', reason: '当前构建是只读/模拟版本', policy: 'requires-explicit-authorization' },
  },
  summary: { executableInThisBuild: false, blocks: [], warnings: [], nextStep: '预演可读通过；真实上传/写表/归档仍需单独授权并通过闸门。' },
  notice: '阶段2A总预演只读：未上传、未公开发布、未写 Excel、未移动或归档文件。',
}

const zhihuPreflight = {
  ...preflight,
  package: { packageId: 'pkg-zhihu', rootName: 'unpublished', relativePath: packages[2].relativePath, title: packages[2].title },
  platform: { requested: 'zhihu', siteKey: '', derived: ['zhihu'], reason: 'ok' },
  snapshot: {
    ...preflight.snapshot,
    siteKey: 'zhihu', platformName: '知乎', account: '当前 Chrome 知乎会话', finalAction: '保存草稿后等待用户检查',
    contentVersion: cv, snapshotId: 'snap-' + '8'.repeat(24),
  },
  registration: { configured: false, status: 'missing-config', notice: '未配置 Excel；不影响草稿验收。' },
  gates: {
    upload: { allowed: false, actionName: '真实上传', reason: '独立上传关闭', policy: 'not-supported-as-standalone-action' },
    publish: { allowed: false, actionName: '公开发布', reason: '公开发布永久关闭', policy: 'not-supported' },
    excelWrite: { allowed: false, actionName: 'Excel 写入登记', reason: '关闭', policy: 'requires-explicit-authorization' },
    archiveMove: { allowed: false, actionName: '移动/归档文章包', reason: '关闭', policy: 'requires-explicit-authorization' },
  },
  summary: { executableInThisBuild: false, blocks: [], warnings: [], nextStep: '完成验收前自检。' },
}

const checklist = {
  mode: 'real-execution-checklist',
  readOnly: true,
  generatedAt: '2026-09-07T00:00:00.000Z',
  package: preflight.package,
  platform: preflight.platform,
  summary: { executableInThisBuild: false, allowedRealActions: 0, closedRealActions: 4, blocks: [], warnings: [] },
  checklistMarkdown: [
    '# 易造发布助手 · 真实执行验收单（只读预览）',
    '',
    '结论：当前构建不可真实执行；0 项真实动作允许，4 项真实动作关闭。',
    '',
    '## 发送快照',
    '- [x] 发送快照可读：snap-999999999999999999999999',
    '',
    '## Excel 登记',
    '- [x] 匹配状态：unique（唯一匹配）',
    '',
    '## 归档',
    '- [x] 已配置归档目录：是',
    '',
    '## 真实动作闸门',
    '- [ ] 真实上传/保存草稿：关闭（requires-explicit-authorization）',
    '- [ ] 公开发布：关闭（manual-final-submit-only）',
    '- [ ] Excel 写入登记：关闭（requires-explicit-authorization）',
    '- [ ] 移动/归档文章包：关闭（requires-explicit-authorization）',
  ].join('\n'),
  acceptanceTemplateMarkdown: [
    '# 易造官网（eyzao.com） · 单篇小样本验收模板（后续授权阶段使用）',
    '',
    '> 当前构建只生成模板，不登录、不上传、不保存草稿、不发布、不写表、不归档。',
    '',
    '## 样本范围',
    '- [ ] 仅 1 个专用测试文章包：远程告警型智能防雷厂家',
    '- [ ] 使用专用测试账号和独立 Chrome 资料目录，不与旧助手共用。',
    '- [ ] 使用测试 Excel 副本和测试归档目录，不接触真实台账与文章目录。',
    '',
    '## 后续获授权后的单篇验收步骤',
    '- [ ] 停在最终提交按钮之前，由用户检查后台预览；助手不得点击最终发布。',
  ].join('\n'),
  exportMarkdown: '# 易造发布助手 · 真实执行验收单（只读预览）\n\n---\n\n# 易造官网（eyzao.com） · 单篇小样本验收模板（后续授权阶段使用）\n',
  exportFileName: 'yizao-acceptance-eyzao.com-999999999999.md',
  notice: '只读验收材料：未上传、未公开发布、未写 Excel、未移动或归档文件，也未创建任务。',
}

const capabilities = {
  phase: '3-zhihu-draft-unverified',
  realActionsEnabled: false,
  runtime: {
    serviceVersion: '0.3.0-stage3-zhihu-draft',
    protocol: { name: 'yizao-local-service', version: 2 },
    acceptanceBuildId: 'stage3-zhihu-html-fidelity-v3.3',
    requiredExtensionBuildId: 'stage3-zhihu-html-fidelity-v3.3',
  },
  actions: {
    upload: '真实上传/保存草稿',
    publish: '公开发布',
    excelWrite: 'Excel 写入登记',
    archiveMove: '移动/归档文章包',
  },
  requirementsBeforeRealActions: ['用户在当前会话明确授权真实动作', '发送快照、Excel 匹配、归档预演均通过'],
  platforms: [
    { id: 'eyzao.com', name: '易造官网（eyzao.com）', group: '官网', status: 'simulation-ready', currentActions: ['只读扫描', '发送快照预览', '模拟发布流程'], plannedActions: ['真实后台填写后等待用户最终提交'], evidence: ['模拟数据'], risks: ['真实执行未验收'] },
    { id: 'eyzao.cn', name: '易造官网（eyzao.cn）', group: '官网', status: 'simulation-ready', currentActions: ['只读扫描', '发送快照预览', '模拟发布流程'], plannedActions: ['真实后台填写后等待用户最终提交'], evidence: ['模拟数据'], risks: ['真实执行未验收'] },
    { id: 'yzfanglei.com', name: '易造防雷官网（yzfanglei.com）', group: '官网', status: 'simulation-ready', currentActions: ['只读扫描', '发送快照预览', '模拟发布流程'], plannedActions: ['真实后台填写后等待用户最终提交'], evidence: ['模拟数据'], risks: ['真实执行未验收'] },
    { id: 'baijiahao', name: '百家号', group: '主流平台', status: 'simulation-ready', currentActions: ['只读扫描', '发送快照预览', '模拟发布流程'], plannedActions: ['复用原流程等待用户最终提交'], evidence: ['模拟数据'], risks: ['真实账号未验收'] },
    { id: 'zhihu', name: '知乎', group: '主流平台', status: 'guarded-draft-unverified', workflow: 'guarded-draft', currentActions: ['只读扫描', '受保护单篇草稿'], plannedActions: ['真实验收'], evidence: ['自动测试'], risks: ['真实账号未验收'] },
    { id: 'sohu', name: '搜狐号', group: '主流平台', status: 'draft-simulation', currentActions: ['只读扫描', '扩展本地草稿流程模拟'], plannedActions: ['保存草稿'], evidence: ['模拟数据'], risks: ['表格保真未验收'] },
    { id: 'toutiao', name: '头条号', group: '待适配平台', status: 'not-adapted', currentActions: ['只读扫描'], plannedActions: ['小样本草稿验收'], evidence: ['当前开发副本未验证'], risks: ['不得显示发布成功'] },
    { id: 'netease', name: '网易号', aliases: ['网易', '网易号'], group: '主流平台', status: 'draft-simulation', workflow: 'draft-simulation', currentActions: ['只读扫描', '扩展本地草稿流程模拟'], plannedActions: ['小样本草稿验收'], evidence: ['仅本地模拟'], risks: ['不得显示草稿或发布成功'] },
    { id: 'xiaohongshu', name: '小红书', group: '待适配平台', status: 'not-adapted', currentActions: ['只读扫描'], plannedActions: ['小样本草稿验收'], evidence: ['当前开发副本未验证'], risks: ['不得显示发布成功'] },
  ],
}

const server = http.createServer(async (req, res) => {
  const file = path.resolve(distRoot, '.' + decodeURIComponent(req.url.split('?')[0]))
  if (!file.startsWith(distRoot + path.sep)) { res.writeHead(403); res.end(); return }
  try {
    const data = await fs.readFile(file)
    res.setHeader('Content-Type', file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream')
    res.end(data)
  } catch { res.writeHead(404); res.end() }
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))

let browser
let healthMismatch = false
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1500 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.addInitScript(() => {
    if (window.top !== window) return
    const read = () => JSON.parse(localStorage.getItem('__chrome_storage_mock__') || '{}')
    const write = (value) => localStorage.setItem('__chrome_storage_mock__', JSON.stringify(value))
    if (!read().yizao_service_token) write({ ...read(), yizao_service_token: 'a'.repeat(64) })
    globalThis.chrome = { runtime: {
      getManifest: () => ({ version: '2.0.9.6' }),
      sendMessage: async (message) => message.type === 'CHECK_AUTH' ? { auth: { isAuthenticated: true } } : { error: 'mock only permits auth checks' },
    }, storage: { local: {
      get: async (key) => typeof key === 'string' ? { [key]: read()[key] } : { ...read() },
      set: async (values) => write({ ...read(), ...values }),
    } } }
  })
  await page.route('http://127.0.0.1:8788/**', async (route) => {
    const req = route.request()
    if (req.url().endsWith('/api/health')) return route.fulfill({ json: { ok: true, name: 'yizao-sync-service', version: healthMismatch ? 'old-service' : '0.3.0-stage3-zhihu-draft', protocol: { name: 'yizao-local-service', version: 2 }, build: { packageVersion: 33, id: 'stage3-zhihu-html-fidelity-v3.3', extensionBuildId: 'stage3-zhihu-html-fidelity-v3.3' } } })
    const message = req.postDataJSON()
    if (message.command === 'getConfig') return route.fulfill({ json: { ok: true, roots: { unpublished: { configured: true, resolved: 'C:\\模拟目录\\未发布' }, published: { configured: true, resolved: 'C:\\模拟目录\\已发布' }, archive: { configured: true, resolved: 'C:\\模拟目录\\已归档' } }, excel: { configured: true, resolved: 'C:\\模拟目录\\计划表\\阶段1C模拟登记表.xlsx', sheetName: '9月执行计划' }, mappings: { platformValues: { 'eyzao.com': ['官网', 'eyzao.com', 'www.eyzao.com'], baijiahao: ['百家号', 'baijiahao'], zhihu: ['知乎', 'zhihu'], sohu: ['搜狐', '搜狐号', 'sohu'] } }, captionPolicy: { official: 'keep-existing-only', baijiahao: 'keep-existing-only', draft: 'use-existing-alt-after-preview' } } })
    if (message.command === 'scan') return route.fulfill({ json: { ok: true, packages } })
    if (message.command === 'getPackage') {
      const pkg = packages.find((p) => p.packageId === message.payload.packageId)
      if (!pkg) return route.fulfill({ status: 400, json: { ok: false, error: 'unknown pkg' } })
      return route.fulfill({ json: { ok: true, ...packageDetail(pkg) } })
    }
    if (message.command === 'prepareOfficialTask') return route.fulfill({ json: { ok: true, ...officialPreview } })
    if (message.command === 'previewExcelRegistration') return route.fulfill({ json: { ok: true, ...registrationPreview } })
    if (message.command === 'preflightPackage') return route.fulfill({ json: { ok: true, ...(message.payload.platform === 'zhihu' ? zhihuPreflight : preflight) } })
    if (message.command === 'generateRealExecutionChecklist') return route.fulfill({ json: { ok: true, ...checklist } })
    if (message.command === 'getShareableConfigTemplate') return route.fulfill({ json: { ok: true, template: { schema: 'yizao-config-template', version: 2, createdAt: '2026-09-05T00:00:00.000Z', excel: { sheetName: '9月执行计划' }, mappings: { platformValues: { 'eyzao.com': ['官网', 'eyzao.com', 'www.eyzao.com'], baijiahao: ['百家号', 'baijiahao'] } }, captionPolicy: { official: 'keep-existing-only', baijiahao: 'keep-existing-only', draft: 'use-existing-alt-after-preview' }, notes: ['模拟模板不含个人路径'] }, excluded: ['roots.unpublished', 'roots.published', 'roots.archive', 'excel.planPath', 'security.trustedOrigin', 'token', 'tasks', 'logs'] } })
    if (message.command === 'importShareableConfigTemplate') return route.fulfill({ json: { ok: true, imported: true, notice: '已导入团队规则；个人目录、Excel 文件路径、配对令牌、任务历史均未从模板导入。' } })
    if (message.command === 'getCapabilities') return route.fulfill({ json: { ok: true, ...capabilities } })
    if (message.command === 'checkRealActionGate') {
      const platform = capabilities.platforms.find((p) => p.id === message.payload.platform)
      const actionName = capabilities.actions[message.payload.action] || message.payload.action || '未知动作'
      return route.fulfill({ json: {
        ok: true,
        allowed: false,
        action: message.payload.action,
        actionName,
        platform: message.payload.platform,
        platformName: platform?.name || message.payload.platform,
        policy: message.payload.action === 'publish' && ['eyzao.com', 'baijiahao'].includes(message.payload.platform) ? 'manual-final-submit-only' : 'requires-explicit-authorization',
        reason: '当前构建是只读/模拟版本，真实动作未启用。',
        requirements: capabilities.requirementsBeforeRealActions,
      } })
    }
    if (message.command === 'simulateOfficialTask') return route.fulfill({ json: { ok: true, mode: 'simulate', started: true, siteKey: 'eyzao.com', reason: 'created', detail: '模拟任务已创建并推进到终态。', task: serverTask } })
    if (message.command === 'confirmPublishedSimulated') {
      serverTask = {
        ...serverTask,
        publish: { status: '人工确认已发布', detail: `模拟人工确认：正式链接 ${message.payload.publicUrl || '（未填写）'}。本服务未打开后台、未提交发布。`, publicUrl: message.payload.publicUrl || '', updatedAt: iso },
        updatedAt: '2026-09-04T09:40:00.000Z',
      }
      return route.fulfill({ json: { ok: true, mode: 'confirm-published-simulated', simulatedOnly: true, task: serverTask, notice: '仅更新本地模拟任务状态：未打开平台、未点击发布、未写 Excel、未移动或归档文件。' } })
    }
    if (message.command === 'confirmExcelRegisteredSimulated') {
      serverTask = {
        ...serverTask,
        excel: { status: '已登记', detail: '模拟人工确认 Excel 登记：工作表 9月执行计划。未写入真实 Excel。', sheetName: '9月执行计划', updatedAt: iso },
        updatedAt: '2026-09-04T09:45:00.000Z',
      }
      return route.fulfill({ json: { ok: true, mode: 'confirm-excel-registered-simulated', simulatedOnly: true, task: serverTask, notice: '仅更新本地模拟任务状态：未读取写回真实 Excel、未移动或归档文件。' } })
    }
    if (message.command === 'confirmArchivedSimulated') {
      serverTask = {
        ...serverTask,
        archive: { status: '已归档', detail: '模拟人工确认归档：未移动、未复制、未删除真实文件。', targetPreview: message.payload.targetPreview || '', updatedAt: iso },
        updatedAt: '2026-09-04T09:50:00.000Z',
      }
      return route.fulfill({ json: { ok: true, mode: 'confirm-archived-simulated', simulatedOnly: true, task: serverTask, notice: '仅更新本地模拟任务状态：未复制、未移动、未删除任何文件。' } })
    }
    if (message.command === 'getTasks') return route.fulfill({ json: { ok: true, count: 1, tasks: [serverTask] } })
    if (message.command === 'removeTask') return route.fulfill({ json: { ok: true, removed: true } })
    return route.fulfill({ status: 400, json: { ok: false, error: 'unexpected command' } })
  })

  async function shot(name) {
    await page.evaluate(() => {
      document.getElementById('sim-banner')?.remove()
      const d = document.createElement('div')
      d.id = 'sim-banner'
      d.textContent = '【模拟数据】阶段2J 只读+模拟 · 未连接真实账号 · 未执行任何真实上传/发布/Excel写入/归档'
      Object.assign(d.style, { position: 'fixed', top: '0', left: '0', right: '0', zIndex: '999999', textAlign: 'center', background: '#fff7e6', color: '#8a5a00', borderBottom: '1px solid #e0b460', padding: '3px 8px', fontSize: '13px', fontFamily: 'system-ui, "Microsoft YaHei", sans-serif' })
      document.body.prepend(d)
    })
    await page.screenshot({ path: path.join(extensionRoot, name), fullPage: true })
  }

  await page.goto(`http://127.0.0.1:${server.address().port}/src/workbench/index.html`)
  await page.getByRole('button', { name: '配置', exact: true }).click()
  await page.getByRole('heading', { name: '配置向导（首次使用）' }).waitFor()
  await page.getByRole('button', { name: '生成可分享模板' }).click()
  await page.getByText('已生成团队配置模板').waitFor()
  assert.equal(await page.locator('main').innerText().then((t) => t.includes('个人目录')), true, '配置向导需要分步骤展示个人目录')
  assert.equal(await page.locator('main').innerText().then((t) => t.includes('平台字段映射')), true, '配置向导需要展示平台映射')
  assert.equal(await page.locator('main').innerText().then((t) => t.includes('图片图注策略')), true, '配置向导需要展示图注策略')
  assert.equal(await page.locator('main').innerText().then((t) => t.includes('roots.unpublished')), true, '模板导出需要明确排除个人路径')
  await shot('workbench-2b-config-wizard.png')
  await page.getByRole('button', { name: '文章库', exact: true }).click()
  assert.equal(await page.getByRole('heading', { name: '配置向导（首次使用）' }).count(), 0, '配置向导与文章库必须是独立功能页')

  await page.getByRole('button', { name: '扫描未发布' }).click()
  await page.getByRole('button', { name: /易造新品发布通稿/ }).waitFor()
  assert.equal(await page.locator('.source-group').count(), 5, '五个来源分组：官网/百家号/知乎/头条/网易')
  assert.equal(await page.locator('.pkg[data-cap="publish-preview"]').count(), 2, '官网与百家号 = 发布流程预览')
  assert.equal(await page.locator('.pkg[data-cap="guarded-draft"]').count(), 1, '知乎 = 受保护单篇草稿')
  assert.equal(await page.locator('.pkg[data-cap="draft-preview"]').count(), 1, '网易 = 草稿流程预览')
  assert.equal(await page.locator('.pkg[data-cap="not-ready"]').count(), 1, '头条 = 待适配')
  const notReady = page.locator('.pkg[data-cap="not-ready"]')
  assert.equal(await notReady.isDisabled(), true, '待适配卡片禁用')
  assert.equal((await notReady.locator('.pkg-action').innerText()).trim(), '待适配')
  await page.getByLabel('平台筛选').selectOption({ label: '知乎' })
  assert.equal(await page.locator('.pkg').count(), 1, '选择知乎后只显示知乎文章')
  await page.getByLabel('搜索文章').fill('不存在的文章')
  await page.getByText('没有找到符合条件的文章。').waitFor()
  await page.getByRole('button', { name: '查看全部' }).click()
  assert.equal(await page.locator('.pkg').count(), 5, '查看全部应清除组合筛选')
  await shot('workbench-1b-library.png')

  await page.getByRole('button', { name: '平台与账号' }).click()
  await page.getByText('真实动作未启用').waitFor()
  assert.equal(await page.locator('.cap-card[data-status="simulation-ready"]').count(), 4, '三个官网站点与百家号可做模拟')
  assert.equal(await page.locator('.cap-card[data-status="draft-simulation"]').count(), 2, '搜狐/网易可做草稿流程模拟')
  assert.equal(await page.locator('.cap-card[data-status="not-adapted"]').count(), 2, '头条/小红书仍待适配')
  await shot('workbench-1d-platform-capabilities.png')

  await page.getByRole('button', { name: '安全闸门' }).click()
  await page.getByRole('heading', { name: '安全闸门 · 真实动作检查（Stage 3）' }).waitFor()
  await page.getByRole('button', { name: '检查真实动作闸门（只读）' }).click()
  await page.locator('.gate-table tbody tr').first().waitFor()
  assert.equal(await page.locator('.gate-table tbody tr').count(), capabilities.platforms.length * Object.keys(capabilities.actions).length, '真实动作闸门需要逐平台逐动作检查')
  assert.equal(await page.locator('.gate-table tbody tr[data-allowed="yes"]').count(), 0, '当前阶段不得允许任何真实动作')
  await page.getByText(/0 项允许/).waitFor()
  await shot('workbench-2h-real-action-gates.png')

  // 知乎草稿模拟（扩展本地），先建一条，稍后用于任务中心合并展示。
  await page.getByRole('button', { name: '文章库' }).click()
  await page.getByRole('button', { name: /智能雷暴仪预警应用/ }).click()
  await page.getByRole('button', { name: '检查准备状态（可选）' }).click()
  await page.getByText('10/10 自检通过。点击保存时仍会重新检查。').waitFor()
  assert.equal(await page.getByRole('button', { name: '一键保存到知乎草稿' }).isEnabled(), true, '主按钮无需用户预先执行检查或勾选确认')
  assert.equal(await page.getByRole('checkbox').count(), 0, '当次确认改由保存前弹窗完成，不再要求单独勾选')
  healthMismatch = true
  await page.getByRole('button', { name: '检查准备状态（可选）' }).click()
  await page.getByText(/服务版本不匹配/).first().waitFor()
  assert.equal(await page.getByRole('button', { name: '一键保存到知乎草稿' }).isDisabled(), true, '服务/扩展版本不匹配时真实草稿按钮必须阻止')
  healthMismatch = false
  await page.getByRole('button', { name: '检查准备状态（可选）' }).click()
  await page.getByText('10/10 自检通过。点击保存时仍会重新检查。').waitFor()
  page.once('dialog', async (dialog) => {
    assert.match(dialog.message(), /仅为当前文章.*保存一篇知乎草稿/, '一键保存仍须当次明确确认')
    await dialog.dismiss()
  })
  await page.getByRole('button', { name: '一键保存到知乎草稿' }).click()
  await page.getByText('已取消：未向知乎保存草稿。').waitFor()
  await shot('workbench-3-zhihu-one-click.png')
  await page.getByRole('button', { name: '生成小样本验收材料（只读）' }).click()
  await page.getByRole('heading', { name: '真实执行验收材料（只读预览）' }).waitFor()
  assert.equal(await page.locator('.checklist-section').count(), 2, '知乎草稿预览也应提供只读验收单与小样本模板')
  await page.getByRole('button', { name: '仅运行模拟' }).click()
  await page.waitForSelector('.task-head strong:has-text("智能雷暴仪预警应用")', { timeout: 5000 })

  // 回文章库，打开官网包，走「发布流程预览」。
  await page.getByRole('button', { name: '文章库' }).click()
  await page.getByRole('button', { name: /易造新品发布通稿/ }).click()
  await page.getByText('发布流程预览（易造官网（eyzao.com） · 阶段2J 仅模拟）').waitFor()
  await page.getByRole('button', { name: '生成执行预览与发送快照' }).click()
  await page.waitForSelector('.flow-meta', { timeout: 8000 })
  assert.equal(await page.locator('main').innerText().then((t) => t.includes(taskKey)), true, '预览要显示稳定任务键')
  assert.equal(await page.locator('main').innerText().then((t) => t.includes('等待用户最终提交（模拟）——绝不自动发布')), true, '终态动作必须为等待用户最终提交')
  await shot('workbench-1b-publish-preview.png')

  await page.getByRole('button', { name: '只读预览台账匹配' }).click()
  await page.getByText(/唯一匹配：第 2 行/).waitFor({ timeout: 8000 })
  assert.equal(await page.locator('main').innerText().then((t) => t.includes('未写入 Excel、未登记任务、未移动或归档文章包')), true, '台账预览必须显示只读边界')
  await shot('workbench-1c-excel-registration-preview.png')

  await page.getByRole('button', { name: '发布前总预演（只读）' }).click()
  await page.getByRole('heading', { name: '发布前总预演（只读）' }).waitFor()
  await page.locator('.preflight-card .gate-banner strong', { hasText: '预演可读通过' }).waitFor()
  assert.equal(await page.locator('main').innerText().then((t) => t.includes('阶段2A总预演只读：未上传、未公开发布、未写 Excel、未移动或归档文件')), true, '总预演必须显示只读边界')
  await shot('workbench-2a-preflight.png')

  await page.getByRole('button', { name: '生成真实执行验收单（只读）' }).click()
  await page.getByRole('heading', { name: '真实执行验收材料（只读预览）' }).waitFor()
  assert.equal(await page.locator('.checklist-section textarea').first().inputValue().then((t) => t.includes('真实执行验收单（只读预览）')), true, '验收单需要可复制文本')
  assert.equal(await page.locator('.checklist-section textarea').first().inputValue().then((t) => t.includes('真实动作闸门')), true, '验收单必须包含真实动作闸门')
  assert.equal(await page.locator('.checklist-section textarea').last().inputValue().then((t) => t.includes('单篇小样本验收模板')), true, '必须展示分平台单篇小样本模板')
  assert.equal(await page.locator('.checklist-section textarea').last().inputValue().then((t) => t.includes('独立 Chrome 资料目录')), true, '小样本模板必须提示浏览器资料隔离')
  assert.equal(await page.locator('main').innerText().then((t) => t.includes('0 项允许 / 4 项关闭')), true, '验收单必须显示当前不可真实执行')
  await page.getByRole('button', { name: '复制完整验收材料' }).click()
  await page.getByText('完整验收材料已复制').waitFor()
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: '下载 Markdown' }).click()
  const download = await downloadPromise
  assert.equal(download.suggestedFilename(), checklist.exportFileName, '下载文件名必须由只读验收响应提供')
  await page.getByText(/验收材料已下载/).waitFor()
  await shot('workbench-2j-acceptance-materials.png')

  await page.getByRole('button', { name: '模拟运行发布流程（等待用户最终提交，绝不自动发布）' }).click()
  await page.locator('.task-step', { hasText: '等待用户最终提交（模拟）' }).waitFor({ timeout: 8000 })
  await page.locator('.task-step', { hasText: '模拟完成（未保存草稿）' }).waitFor({ timeout: 20000 })
  await page.locator('.task-step[data-state="done"]').first().waitFor()
  assert.equal(await page.locator('main').innerText().then((t) => t.includes('确认登记') && t.includes('未登记')), true, '登记状态独立展示')
  assert.equal(await page.locator('main').innerText().then((t) => t.includes('按发布包汇总 · 归档门槛预览')), true, '任务中心需要显示归档门槛汇总')
  assert.equal(await page.locator('main').innerText().then((t) => t.includes('不可归档')), true, '模拟任务不应让共享包进入归档')
  assert.equal(await page.locator('main').innerText().then((t) => t.includes('草稿、模拟完成、等待用户最终提交都不算正式发布')), true, '归档门槛必须解释草稿不等于发布')
  assert.equal(await page.locator('main').innerText().then((t) => t.includes('结果待核对（重启中断）')), false)
  await shot('workbench-1b-task-center.png')
  await shot('workbench-2c-archive-gate.png')

  await page.getByPlaceholder('正式链接（模拟，可留空）').first().fill('https://www.eyzao.com/news/demo.html')
  await page.getByRole('button', { name: '模拟确认已发布' }).first().click()
  await page.getByText('已模拟确认发布').waitFor()
  assert.equal(await page.locator('main').innerText().then((t) => t.includes('人工确认已发布')), true, '模拟确认后发布状态应更新')
  assert.equal(await page.locator('main').innerText().then((t) => t.includes('确认登记') && t.includes('未登记')), true, '模拟确认发布不得自动登记 Excel')
  assert.equal(await page.locator('main').innerText().then((t) => t.includes('确认归档') && t.includes('未归档')), true, '模拟确认发布不得自动归档')
  await shot('workbench-2d-manual-confirm.png')

  await page.getByRole('button', { name: '模拟确认已登记' }).first().click()
  await page.getByText('已模拟登记').waitFor()
  assert.equal(await page.locator('main').innerText().then((t) => t.includes('确认登记') && t.includes('已登记')), true, '模拟确认登记后 Excel 状态应更新')
  assert.equal(await page.locator('main').innerText().then((t) => t.includes('确认归档') && t.includes('未归档')), true, '模拟确认登记不得自动归档')
  assert.equal(await page.locator('main').innerText().then((t) => t.includes('未写入真实 Excel')), true, '登记确认必须说明未写真实 Excel')
  await shot('workbench-2e-excel-confirm.png')

  await page.getByRole('button', { name: '模拟确认已归档' }).first().click()
  await page.getByRole('button', { name: '已模拟归档' }).first().waitFor()
  await page.getByText('已模拟归档完成').waitFor()
  await page.locator('.task-step[data-state="done"]').nth(3).waitFor()
  assert.equal(await page.locator('main').innerText().then((t) => t.includes('确认归档') && t.includes('已归档')), true, '模拟确认归档后归档状态应更新')
  assert.equal(await page.locator('main').innerText().then((t) => t.includes('未移动、未复制、未删除真实文件')), true, '归档确认必须说明未移动真实文件')
  await shot('workbench-2f-archive-confirm.png')
  await shot('workbench-2g-task-stepper.png')

  assert.deepEqual(errors, [])
  console.log('1B/1C/1D/2A/2B/2C/2D/2E/2F/2G/2H/2I/2J SHOTS PASS: config wizard, capability tags, official publish-flow preview, Excel read-only registration preview, platform capabilities, real-action safety gates, total preflight, copy/download readiness materials, per-platform single-sample template, disabled not-ready, merged task center, archive gate preview, manual publish/excel/archive confirm simulation, task stepper cleanup; all screenshot data is simulated.')
} finally {
  await browser?.close()
  await new Promise((resolve) => server.close(resolve))
}
