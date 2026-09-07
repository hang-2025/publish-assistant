import { chromium } from 'playwright'
import http from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const distRoot = path.join(extensionRoot, 'dist')
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jC1sAAAAASUVORK5CYII='
const packages = [
  { packageId: 'pkg-normal', relativePath: '主流平台/zhihu/智能雷暴仪/2026-09-02/正常包', segments: ['主流平台', 'zhihu', '智能雷暴仪', '2026-09-02', '正常包'], title: '智能雷暴仪预警应用', imageCount: 1, altCount: 1, issueCount: 0, issues: [], notes: [] },
  { packageId: 'pkg-related', relativePath: '主流平台/zhihu/智能雷暴仪/2026-09-03/关联包', segments: ['主流平台', 'zhihu', '智能雷暴仪', '2026-09-03', '关联包'], title: '机场雷电预警系统怎么选', imageCount: 5, altCount: 5, issueCount: 0, issues: [], notes: [] },
  { packageId: 'pkg-other-category', relativePath: '主流平台/zhihu/浪涌保护器/2026-09-04/分类包', segments: ['主流平台', 'zhihu', '浪涌保护器', '2026-09-04', '分类包'], title: '浪涌保护器选型要点', imageCount: 5, altCount: 5, issueCount: 0, issues: [], notes: [] },
  { packageId: 'pkg-conflict', relativePath: '主流平台/sohu/智能雷暴仪/2026-09-05/冲突包', segments: ['主流平台', 'sohu', '智能雷暴仪', '2026-09-05', '冲突包'], title: 'ALT 冲突测试包', imageCount: 1, altCount: 1, issueCount: 1, issues: ['ALT 冲突'], notes: [] },
]
function detail(conflict = false) {
  return {
    packageId: conflict ? 'pkg-conflict' : 'pkg-normal', root: 'unpublished',
    relativePath: conflict ? packages[1].relativePath : packages[0].relativePath,
    title: conflict ? packages[1].title : packages[0].title,
    seo: { 内容栏目: '智能雷暴仪', SEO描述: '阶段1A 模拟数据' },
    html: '<script>window.__unsafe=1</script><figure><img src="06-发布图片/1-雷暴仪.png" alt="HTML ALT" onerror="window.__unsafe=2"><figcaption>雷暴仪现场已有图注</figcaption></figure>',
    alts: [{ number: 1, alt: conflict ? '清单 ALT' : 'HTML ALT' }], altSource: '03-图片ALT清单.txt',
    images: [{ number: 1, name: '1-雷暴仪.png', dir: '06-发布图片', bytes: 68, sha256: 'a'.repeat(64), dataUrl: png, alt: conflict ? '清单 ALT' : 'HTML ALT', altSource: '03-图片ALT清单.txt', duplicateOf: null }],
    occurrences: [{ occurrenceId: 'img-1', position: 1, src: '06-发布图片/1-雷暴仪.png', name: '1-雷暴仪.png', assetNumber: 1, assetName: '1-雷暴仪.png', assetDir: '06-发布图片', assetMatch: '正文文件名唯一匹配', manifestAlt: conflict ? '清单 ALT' : 'HTML ALT', htmlAlt: 'HTML ALT', effectiveAlt: conflict ? '清单 ALT' : 'HTML ALT', altSource: '03-图片ALT清单.txt', altConflict: conflict, caption: '雷暴仪现场已有图注', captionSource: '正文 figcaption' }],
    issues: conflict ? ['ALT 冲突：清单与 HTML 不一致'] : [], notes: ['模拟发布包，不含真实文章'],
    fileList: [{ relative: '02-后台一键复制正文.html', bytes: 256 }, { relative: '06-发布图片/1-雷暴仪.png', bytes: 68 }],
  }
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
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.addInitScript(() => {
    if (window.top !== window) return
    const read = () => JSON.parse(localStorage.getItem('__chrome_storage_mock__') || '{}')
    const write = (value) => localStorage.setItem('__chrome_storage_mock__', JSON.stringify(value))
    if (!read().yizao_service_token) write({ ...read(), yizao_service_token: 'a'.repeat(64) })
    globalThis.chrome = { storage: { local: {
      get: async (key) => typeof key === 'string' ? { [key]: read()[key] } : { ...read() },
      set: async (values) => write({ ...read(), ...values }),
    } } }
  })
  await page.route('http://127.0.0.1:8788/**', async (route) => {
    const req = route.request()
    if (req.url().endsWith('/api/health')) return route.fulfill({ json: { ok: true, version: 'test', protocol: { name: 'yizao-local-service', version: 1 } } })
    const message = req.postDataJSON()
    if (message.command === 'getConfig') return route.fulfill({ json: { ok: true, roots: { unpublished: { configured: true, resolved: 'C:\\模拟目录\\未发布' }, published: { configured: true, resolved: 'C:\\模拟目录\\已发布' } } } })
    if (message.command === 'scan') return route.fulfill({ json: { ok: true, packages } })
    if (message.command === 'getPackage') return route.fulfill({ json: { ok: true, ...detail(message.payload.packageId === 'pkg-conflict') } })
    if (message.command === 'getTasks') return route.fulfill({ json: { ok: true, count: 0, tasks: [] } })
    return route.fulfill({ status: 400, json: { ok: false, error: 'unexpected command' } })
  })

  await page.goto(`http://127.0.0.1:${server.address().port}/src/workbench/index.html`)
  await page.getByRole('button', { name: '扫描未发布' }).click()
  await page.getByRole('button', { name: /智能雷暴仪预警应用/ }).waitFor()
  assert.equal(await page.locator('.source-group').count(), 2, '应按知乎/搜狐分成两个平台区块')
  assert.equal(await page.locator('.category-group').count(), 3, '知乎两个产品分类，搜狐一个产品分类')
  // 阶段1B：知乎/搜狐卡片应为「草稿流程预览」并带能力标签；绝不能出现真实成功文案。
  assert.equal(await page.locator('.pkg').count(), 4, '应显示 4 张文章卡片')
  const pkgActions = page.locator('.pkg-action')
  assert.equal(await pkgActions.count(), 4, '每张卡片都有一个能力动作文案')
  for (let i = 0; i < 4; i++) assert.equal((await pkgActions.nth(i).innerText()).trim(), '草稿流程预览', '知乎/搜狐卡片一律为「草稿流程预览」')
  assert.equal(await page.locator('.tag').count() > 0, true, '卡片应有能力标签')
  const libraryBody = await page.locator('main').innerText()
  assert.equal(libraryBody.includes('一键发布成功'), false, '绝不能出现「一键发布成功」')
  assert.equal(libraryBody.includes('草稿已保存'), false, '模拟不能显示「草稿已保存」')
  assert.equal(await page.locator('.pkg[data-cap="not-ready"]').count(), 0, '本轮夹具没有待适配卡片')
  await page.getByRole('button', { name: /智能雷暴仪预警应用/ }).click()
  await page.getByText('正文出现位置映射（1）').waitFor()
  assert.equal(await page.getByText(/雷暴仪现场已有图注/).count() > 0, true)
  const frame = page.frameLocator('iframe[title="正文预览"]')
  await frame.locator('img').waitFor()
  assert.equal(await frame.locator('script').count(), 0)
  assert.equal(await frame.locator('img').getAttribute('onerror'), null)
  assert.equal(await frame.locator('figcaption').textContent(), '雷暴仪现场已有图注')
  await page.screenshot({ path: path.join(extensionRoot, 'workbench-preview.png'), fullPage: true })

  await page.getByRole('button', { name: /ALT 冲突测试包/ }).click()
  await page.getByText('ALT 文案冲突，模拟校验会停止').waitFor()
  await page.getByRole('button', { name: /创建模拟草稿任务/ }).click()
  await page.locator('.task-step', { hasText: '失败' }).waitFor()
  await page.getByText(/未上传、未保存草稿、未登记、未归档/).waitFor()

  // 人工构造一个“重启时仍在保存”的任务，刷新后必须变为结果未知且不自动重发。
  await page.evaluate(async () => {
    const now = Date.now()
    await chrome.storage.local.set({ yizao_workbench_tasks: [{
      id: 'restart-test', packageId: 'pkg-normal', title: '重启恢复测试', root: 'unpublished', relativePath: '模拟', platform: 'zhihu', platformName: '知乎', imageCount: 1, validationIssueCount: 0, simulated: true, createdAt: now, updatedAt: now,
      draft: { stage: '保存中', detail: '模拟中断' }, publish: '未发布', register: '未登记', archive: '未归档',
    }, {
      id: 'legacy-wording', packageId: 'pkg-normal', title: '旧模拟文案迁移', root: 'unpublished', relativePath: '模拟', platform: 'zhihu', platformName: '知乎', imageCount: 1, validationIssueCount: 0, simulated: true, createdAt: now, updatedAt: now,
      draft: { stage: '待人工发布', detail: '旧模拟草稿已保存' }, publish: '未发布', register: '未登记', archive: '未归档',
    }] })
  })
  await page.reload()
  await page.getByRole('button', { name: /任务中心/ }).click()
  await page.locator('.task-step', { hasText: '结果未知（重启中断）' }).waitFor()
  await page.locator('.task-step', { hasText: '模拟完成（未保存草稿）' }).waitFor()
  await page.getByText(/没有调用知乎或其他平台/).waitFor()
  assert.deepEqual(errors, [])
  console.log('WORKBENCH UI PASS: mocked read-only scan, sanitized preview, explicit image/ALT/caption mapping, validation stop, restart becomes unknown; no real service/account/files used.')
} finally {
  await browser?.close()
  await new Promise((resolve) => server.close(resolve))
}
