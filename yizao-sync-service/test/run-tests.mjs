import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { resolveInside, assertRootsIndependent, assertRootSetIndependent } from '../lib/security.mjs';
import { CrossProcessLock } from '../lib/mutex.mjs';
import { createArticle, articleFromScanResult, articleFromPackageDetail, transitionArticleLifecycle } from '../domain/article.mjs';
import { createTask, taskFromLegacyRecord, transitionTaskStatus } from '../domain/task.mjs';
import { ARTICLE_STATUS, TASK_STATUS, VALIDATION_STATUS } from '../domain/status.mjs';
import { InMemoryArticleRepository } from '../repositories/article-repository.mjs';
import { TaskRepository } from '../repositories/task-repository.mjs';
import { ReadOnlyExcelRepository } from '../repositories/excel-repository.mjs';
import { ArticleService } from '../services/article-service.mjs';
import { PlatformRegistry, platformRegistry } from '../platforms/registry.mjs';
import { getCapabilities, checkRealActionGate } from '../lib/capabilities.mjs';
import { writeXlsx } from '../lib/xlsx.mjs';
import { createCommandRouter } from '../routes/command-router.mjs';
import { parseAltFile } from '../lib/package.mjs';

/**
 * 阶段1A 测试：全部在系统临时目录中构造夹具，不读取、不修改真实文章目录与真实 Excel。
 * 覆盖：中文路径、缺图、乱序、同名文件、重复图片、空 ALT、符号链接/junction 越界、
 * 服务端 Host/Origin/令牌/命令白名单校验、跨进程互斥锁。
 */

const ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'yizao-1a-'));
const UNPUB = path.join(ROOT, '未发布');
const PUB = path.join(ROOT, '已发布');
const ARCHIVE = path.join(ROOT, '归档');
const EXTERNAL = path.join(ROOT, '外部目录');
const PORT = 8791;
const DATA_DIR = path.join(ROOT, 'svc-data');
const PLAN_XLSX = path.join(ROOT, '计划表.xlsx');
const PLAN_TXT = path.join(ROOT, '计划表.txt');
await fs.writeFile(PLAN_XLSX, '仅用于路径配置测试，不读取内容');
await fs.writeFile(PLAN_TXT, '不是 xlsx');

test('ALT 清单解析保留图片编号前缀和内容冒号', () => {
  assert.deepEqual(parseAltFile([
    '1.jpg：图片1：风电场智能防雷系统覆盖风机',
    '2-image.png|图片2: 数据链路：采集至平台',
  ].join('\n')), [
    { number: 1, name: '1.jpg', alt: '图片1：风电场智能防雷系统覆盖风机' },
    { number: 2, name: '2-image.png', alt: '图片2: 数据链路：采集至平台' },
  ]);
});

// 生成内容各不相同的 1x1 像素 PNG（用于重复图片/内容指纹测试）
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(Buffer.concat([t, data])) >>> 0);
  return Buffer.concat([len, t, data, crc]);
}
function makePng(seed) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 2;
  const idat = zlib.deflateSync(Buffer.from([0, seed & 0xff, (seed * 3) & 0xff, (seed * 7) & 0xff]));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))]);
}

async function makePackage(dir, { images, alts, htmlImgs, altFile = '03-图片ALT清单.txt', useJson = false }) {
  await fs.mkdir(path.join(dir, '06-发布图片'), { recursive: true });
  if (useJson) {
    const titles = images.map((n) => n.replace(/\.png$/, ''));
    await fs.writeFile(path.join(dir, '01-SEO元数据.json'), JSON.stringify({ '锁定标题': path.basename(dir), '产品细分': '测试产品', '核心关键词': ['k1'], 'SEO描述': 'd', '锁定选题': 'q' }, null, 2));
    await fs.writeFile(path.join(dir, '07-图片清单与检查.json'), JSON.stringify(alts.map((a, i) => ({ 文件: titles[i], ALT: a }))));
    const htmlBody = htmlImgs.map((n) => `<p>段落</p><img src="06-发布图片/${n}" alt="">`).join('\n');
    await fs.writeFile(path.join(dir, `05-发布版-${path.basename(dir)}.html`), `<!doctype html><html><body>${htmlBody}</body></html>`);
  } else {
    await fs.writeFile(path.join(dir, '01-SEO信息.txt'), `内容栏目：测试产品\n内容标题：${path.basename(dir)}\nSEO标题：${path.basename(dir)}\nSEO关键字：k\nSEO描述：d\n`);
    if (alts) await fs.writeFile(path.join(dir, altFile), alts.map((a, i) => `${i + 1}-图.png：${a}`).join('\n'));
    const htmlBody = htmlImgs.map((n) => `<p>段落</p><img src="06-发布图片/${n}" alt="">`).join('\n');
    await fs.writeFile(path.join(dir, '02-后台一键复制正文.html'), `<!doctype html><html><body>${htmlBody}</body></html>`);
  }
  for (const [name, buf] of images.map((n, i) => [n, makePng(i + 1)])) {
    await fs.writeFile(path.join(dir, '06-发布图片', name), buf);
  }
}

// ---------- 夹具 ----------
await makePackage(path.join(UNPUB, '官网', 'eyzao.com', '浪涌保护器', '2026-09-01', '正常文章包'), {
  images: ['1-雷电预警系统.png', '2-浪涌保护器.png', '3-安装示意图.png'],
  alts: ['ALT一', 'ALT二', 'ALT三'],
  htmlImgs: ['1-雷电预警系统.png', '2-浪涌保护器.png', '3-安装示意图.png'],
});
await makePackage(path.join(UNPUB, '主流平台', 'zhihu', '智能雷暴仪', '2026-09-02', '中文路径 与空格·文章'), {
  images: ['1-图.png', '2-图.png'], alts: ['中文ALT一', '中文ALT二'], htmlImgs: ['1-图.png', '2-图.png'],
});
await makePackage(path.join(UNPUB, '主流平台', 'sohu', '智能雷暴仪', '2026-09-03', '缺图文章包'), {
  images: ['1-图.png', '2-图.png'], alts: ['A1', 'A2', 'A3'], htmlImgs: ['1-图.png', '2-图.png', '3-不存在.png'],
});
await makePackage(path.join(UNPUB, '主流平台', 'zhihu', '雷电预警系统', '2026-09-04', '乱序文章包'), {
  images: ['1-a.png', '2-b.png', '3-c.png'], alts: ['O1', 'O2', 'O3'], htmlImgs: ['3-c.png', '1-a.png', '2-b.png'],
});
await makePackage(path.join(UNPUB, '主流平台', 'sohu', '浪涌保护器', '2026-09-05', '重复图片文章包'), {
  images: ['1-x.png', '2-x.png'], alts: ['R1', 'R2'], htmlImgs: ['1-x.png', '2-x.png'],
});
// 故意让第 2 张与第 1 张内容相同（同一照片重复出现）
await fs.writeFile(path.join(UNPUB, '主流平台', 'sohu', '浪涌保护器', '2026-09-05', '重复图片文章包', '06-发布图片', '2-x.png'), makePng(1));
await makePackage(path.join(UNPUB, '主流平台', 'csdn', '接地电阻监测', '2026-09-06', '空ALT文章包'), {
  images: ['1-m.png'], alts: [''], htmlImgs: ['1-m.png'],
});
await makePackage(path.join(UNPUB, '主流平台', 'zhihu', '雷电预警系统', '2026-09-06', '图注与ALT冲突包'), {
  images: ['1-caption.png'], alts: ['清单 ALT'], htmlImgs: ['1-caption.png'],
});
await fs.writeFile(
  path.join(UNPUB, '主流平台', 'zhihu', '雷电预警系统', '2026-09-06', '图注与ALT冲突包', '02-后台一键复制正文.html'),
  '<!doctype html><html><body><figure><img src="06-发布图片/1-caption.png" alt="HTML ALT"><figcaption>已有可见图注</figcaption></figure></body></html>',
);
// 同名图片在两个 06- 目录
{
  const dir = path.join(UNPUB, '主流平台', 'zhihu', '智能防雷系统', '2026-09-07', '同名文件文章包');
  await makePackage(dir, { images: ['1-same.png'], alts: ['S1'], htmlImgs: ['1-same.png'] });
  await fs.mkdir(path.join(dir, '06-处理后图片-600x400'), { recursive: true });
  await fs.writeFile(path.join(dir, '06-处理后图片-600x400', '1-same.png'), makePng(9));
}
await makePackage(path.join(PUB, '官网', 'eyzao.com', '易造新闻', '2026-08-30', '已发布历史包'), {
  images: ['1-p.png'], alts: ['P1'], htmlImgs: ['1-p.png'],
});
// 授权目录外的包（junction 指向它）
await makePackage(EXTERNAL, { images: ['1-e.png'], alts: ['E1'], htmlImgs: ['1-e.png'] });
// junction：未发布目录内指向外部
await fs.symlink(EXTERNAL, path.join(UNPUB, '主流平台', 'junction-外部'), 'junction');

// ---------- 单元测试：路径安全 ----------
test('领域模型：扫描结果可投影为 Article，详情可在不改变旧响应的前提下补全', async () => {
  const repository = new InMemoryArticleRepository();
  const service = new ArticleService(repository);
  const pkg = {
    packageId: 'pkg-1234567890abcdef12345678',
    relativePath: '主流平台/zhihu/雷电预警/2026-09-01/示例',
    segments: ['主流平台', 'zhihu', '雷电预警', '2026-09-01', '示例'],
    title: '示例文章', issueCount: 0, issues: [],
  };
  const projected = articleFromScanResult(pkg, { rootName: 'unpublished' });
  assert.equal(projected.platform, 'zhihu');
  assert.equal(projected.category, '雷电预警');
  assert.equal(projected.validation.status, VALIDATION_STATUS.PENDING);
  await service.indexScanResults([pkg], { rootName: 'unpublished' });
  await service.enrichPackage({ ...pkg, html: '<p>正文</p>', images: [], issues: [] });
  assert.equal((await repository.getById(pkg.packageId)).validation.status, VALIDATION_STATUS.VALID);
  const blocked = articleFromPackageDetail({ ...pkg, issues: ['缺少 ALT'] }, projected);
  assert.equal(blocked.validation.status, VALIDATION_STATUS.BLOCKED);
});

test('Article lifecycle：合法转换返回新对象，跳级、回退和终态转换被拒绝', () => {
  const discovered = articleFromScanResult({
    packageId: 'pkg-1234567890abcdef12345678',
    relativePath: '主流平台/zhihu/雷电预警/示例',
    segments: ['主流平台', 'zhihu', '雷电预警', '示例'],
    issues: [],
  });
  const path = [
    ARTICLE_STATUS.VALIDATED, ARTICLE_STATUS.READY, ARTICLE_STATUS.QUEUED,
    ARTICLE_STATUS.PROCESSING, ARTICLE_STATUS.DRAFT_SAVED,
    ARTICLE_STATUS.WAITING_USER_CONFIRMATION, ARTICLE_STATUS.PUBLISHED,
    ARTICLE_STATUS.REGISTERED, ARTICLE_STATUS.ARCHIVED,
  ];
  const states = [discovered];
  for (const status of path) states.push(transitionArticleLifecycle(states.at(-1), status));
  const validated = states[1];
  const ready = states[2];
  assert.notEqual(validated, discovered);
  assert.equal(discovered.lifecycleStatus, ARTICLE_STATUS.DISCOVERED);
  assert.equal(ready.lifecycleStatus, ARTICLE_STATUS.READY);
  assert.equal(states.at(-1).lifecycleStatus, ARTICLE_STATUS.ARCHIVED);
  assert.equal(transitionArticleLifecycle(ready, ARTICLE_STATUS.FAILED).lifecycleStatus, ARTICLE_STATUS.FAILED);
  assert.throws(() => transitionArticleLifecycle(discovered, ARTICLE_STATUS.ARCHIVED), /非法状态转换/);
  assert.throws(() => transitionArticleLifecycle(ready, ARTICLE_STATUS.DISCOVERED), /非法状态转换/);
  assert.throws(() => transitionArticleLifecycle({ ...ready, lifecycleStatus: ARTICLE_STATUS.ARCHIVED }, ARTICLE_STATUS.PUBLISHED), /非法状态转换/);
  assert.throws(() => transitionArticleLifecycle(ready, 'made_up'), /非法状态转换/);
  assert.throws(() => createArticle({ lifecycleStatus: 'made_up' }), /状态无效/);
});

test('统一任务状态：旧模拟阶段只做 canonical 投影，不改旧任务记录', () => {
  const legacy = { taskId: 'tsk_1_deadbeef', packageId: 'pkg-x', platform: 'eyzao.com', states: { draft: { stage: '等待用户最终提交（模拟）' } } };
  const canonical = taskFromLegacyRecord(legacy);
  assert.equal(canonical.id, legacy.taskId);
  assert.equal(canonical.status, TASK_STATUS.WAITING_CONFIRMATION);
  assert.equal(legacy.status, undefined);
});

test('Task state machine：允许顺序推进和幂等更新，拒绝跳级、回退、未知及终态转换', () => {
  const pending = createTask({ id: 'task-1', articleId: 'article-1', platform: 'zhihu' });
  const path = [
    TASK_STATUS.VALIDATING, TASK_STATUS.READY, TASK_STATUS.RUNNING,
    TASK_STATUS.UPLOADING, TASK_STATUS.FILLING, TASK_STATUS.SAVING_DRAFT,
    TASK_STATUS.DRAFT_SAVED, TASK_STATUS.WAITING_CONFIRMATION, TASK_STATUS.PUBLISHED,
  ];
  const states = [pending];
  for (const status of path) states.push(transitionTaskStatus(states.at(-1), status));
  const validating = states[1];
  assert.equal(pending.status, TASK_STATUS.PENDING);
  assert.equal(validating.status, TASK_STATUS.VALIDATING);
  assert.notEqual(validating, pending);
  assert.equal(states.at(-1).status, TASK_STATUS.PUBLISHED);
  assert.equal(transitionTaskStatus(validating, TASK_STATUS.VALIDATING).status, TASK_STATUS.VALIDATING);
  assert.equal(transitionTaskStatus(validating, TASK_STATUS.FAILED).status, TASK_STATUS.FAILED);
  assert.equal(transitionTaskStatus(validating, TASK_STATUS.CANCELLED).status, TASK_STATUS.CANCELLED);
  assert.throws(() => transitionTaskStatus(pending, TASK_STATUS.PUBLISHED), /非法状态转换/);
  assert.throws(() => transitionTaskStatus(validating, TASK_STATUS.PENDING), /非法状态转换/);
  assert.throws(() => transitionTaskStatus(validating, 'made_up'), /非法状态转换/);
  assert.throws(() => transitionTaskStatus({ ...pending, status: TASK_STATUS.PUBLISHED }, TASK_STATUS.FAILED), /非法状态转换/);
  assert.throws(() => createTask({ status: 'made_up' }), /状态无效/);
});

test('平台 Registry：知乎仅开放受保护草稿实现，公开发布与未验收能力保持关闭', async () => {
  assert.equal(platformRegistry.get('www.eyzao.com').id, 'eyzao.com');
  assert.equal(platformRegistry.get('知乎').workflow, 'guarded-draft');
  assert.equal(platformRegistry.get('知乎').capabilities.implementationAvailable, true);
  assert.equal(platformRegistry.get('toutiao').workflow, 'unsupported');
  assert.equal(platformRegistry.get('网易').workflow, 'draft-simulation');
  assert.equal(platformRegistry.get('netease').capabilities.simulate, true);
  assert.equal((await platformRegistry.get('netease').saveDraft()).allowed, false);
  assert.equal((await platformRegistry.get('zhihu').saveDraft()).allowed, false);
  assert.equal((await platformRegistry.get('eyzao.com').publish()).allowed, false);
  assert.equal(platformRegistry.list().length, 9);
  for (const adapter of platformRegistry.list()) {
    assert.equal(adapter.capabilities.saveDraft, false);
    assert.equal(adapter.capabilities.publish, false);
    assert.equal(adapter.capabilities.autoPublish, false);
  }
  assert.throws(() => new PlatformRegistry([platformRegistry.get('zhihu'), platformRegistry.get('zhihu')]), /重复或无效/);
});

test('Capabilities：服务端 Registry 元数据已合并，所有真实动作和未知动作继续关闭', () => {
  const capabilities = getCapabilities();
  assert.equal(capabilities.realActionsEnabled, false);
  assert.equal(capabilities.platforms.length, platformRegistry.list().length);
  for (const platform of capabilities.platforms) {
    assert.equal(platform.workflow, platformRegistry.get(platform.id).workflow);
    assert.equal(platform.capabilities.publish, false);
    for (const action of ['upload', 'publish', 'excelWrite', 'archiveMove', 'deleteAll']) {
      assert.equal(checkRealActionGate({ action, platform: platform.id }).allowed, false);
    }
  }
});

test('Repositories：Article 隔离副本，Task 保持旧存储格式并投影 canonical 状态，Excel 只读', async () => {
  const articleRepository = new InMemoryArticleRepository();
  const article = { id: 'article-1', nested: { title: '原值' } };
  await articleRepository.save(article);
  article.nested.title = '调用方修改';
  const stored = await articleRepository.getById(article.id);
  assert.equal(stored.nested.title, '原值');
  stored.nested.title = '读取方修改';
  assert.equal((await articleRepository.getById(article.id)).nested.title, '原值');
  await articleRepository.clear();
  assert.deepEqual(await articleRepository.list(), []);

  const legacy = { taskId: 'tsk_1_deadbeef', packageId: 'pkg-x', platform: 'eyzao.com', states: { draft: { stage: '等待用户最终提交（模拟）' } } };
  const calls = [];
  const taskRepository = new TaskRepository({
    getTask: async (id) => { calls.push(['get', id]); return legacy; },
    listTasks: async () => { calls.push(['list']); return [legacy]; },
    removeTask: async (id) => { calls.push(['remove', id]); return true; },
  });
  assert.equal((await taskRepository.getById(legacy.taskId)).taskId, legacy.taskId);
  assert.equal((await taskRepository.list())[0].status, TASK_STATUS.WAITING_CONFIRMATION);
  assert.equal(await taskRepository.remove(legacy.taskId), true);
  assert.deepEqual(calls, [['get', legacy.taskId], ['list'], ['remove', legacy.taskId]]);

  const excelPath = path.join(ROOT, 'repository-read-only.xlsx');
  await fs.writeFile(excelPath, writeXlsx([{ name: '计划', rows: [['任务编号', '平台'], ['PL-1', '知乎']] }]));
  const excelRepository = new ReadOnlyExcelRepository();
  assert.deepEqual((await excelRepository.read(excelPath)).sheets[0].rows[1], ['PL-1', '知乎']);
  await assert.rejects(() => excelRepository.write(), /禁止 Excel 写入/);
});

test('Command Router：命令仅按白名单分发', async () => {
  const router = createCommandRouter({ ping: async (payload) => ({ value: payload.value }) });
  assert.deepEqual(await router.dispatch({ command: 'ping', payload: { value: 1 } }), { value: 1 });
  await assert.rejects(() => router.dispatch({ command: 'publish', payload: {} }), /未知命令/);
});

test('resolveInside 拒绝 .. 与越界', async () => {
  await assert.rejects(() => resolveInside(UNPUB, '../外部目录'), /越界|\.\./);
  await assert.rejects(() => resolveInside(UNPUB, 'a/../../外部目录'), /越界|\.\./);
});
test('resolveInside 解析 junction 后拒绝外部目标', async () => {
  await assert.rejects(() => resolveInside(UNPUB, '主流平台/junction-外部'), /越界/);
});
test('assertRootsIndependent 拒绝嵌套/相同根目录', () => {
  assert.throws(() => assertRootsIndependent(UNPUB, UNPUB), /相同/);
  assert.throws(() => assertRootsIndependent(UNPUB, path.join(UNPUB, 'sub')), /嵌套/);
  assert.throws(() => assertRootSetIndependent({ unpublished: UNPUB, published: PUB, archive: path.join(UNPUB, '归档') }), /互相嵌套|归档目标目录/);
});
test('跨进程锁：互斥与接管', async () => {
  const dir = path.join(ROOT, 'locks');
  await fs.mkdir(dir, { recursive: true });
  const lockA = new CrossProcessLock(dir, 'site-x');
  assert.equal(await lockA.acquire('A'), true);
  const lockB = new CrossProcessLock(dir, 'site-x');
  assert.equal(await lockB.acquire('B'), false, '同进程持锁时应互斥');
  await lockA.release();
  assert.equal(await lockB.acquire('B'), true, '释放后可获取');
  // 死亡进程接管：手工写入一个不存在的 pid
  await fs.writeFile(path.join(dir, 'executor-dead.lock'), JSON.stringify({ pid: 999999999, owner: 'ghost' }));
  const lockC = new CrossProcessLock(dir, 'dead');
  assert.equal(await lockC.acquire('C'), true, '持有者已死亡时可接管');
});

// ---------- HTTP 服务测试 ----------
let child;
let token = '';
await new Promise((resolve, reject) => {
  child = spawn(process.execPath, [path.join(import.meta.dirname, '..', 'server.mjs')], {
    env: { ...process.env, YIZ_DATA_DIR: DATA_DIR, YIZ_PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; const m = out.match(/[0-9a-f]{64}/); if (m) { token = m[0]; resolve(); } });
  child.stderr.on('data', (d) => process.stderr.write(d));
  child.on('error', reject);
  setTimeout(() => reject(new Error('服务启动超时')), 15000);
});

const BASE = `http://127.0.0.1:${PORT}`;
const EXT_ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const OTHER_EXT_ORIGIN = 'chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba';
async function call(body, { origin = EXT_ORIGIN, token: tk = token, host } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (origin) headers.Origin = origin;
  if (tk) headers.Authorization = `Bearer ${tk}`;
  if (host) headers.Host = host;
  const res = await fetch(`${BASE}/api/command`, { method: 'POST', headers, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json() };
}

test('health 无需令牌，返回版本', async () => {
  const res = await fetch(`${BASE}/api/health`);
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.name, 'yizao-sync-service');
  assert.equal(json.protocol.version, 2);
  assert.equal(json.build.packageVersion, 33);
  assert.equal(json.build.id, 'stage3-zhihu-html-fidelity-v3.3');
});

test('命令接口：无 Origin / 网页 Origin / 错误 Host 一律拒绝', async () => {
  assert.equal((await call({ command: 'getConfig' }, { origin: null })).status, 403);
  assert.equal((await call({ command: 'getConfig' }, { origin: 'https://evil.example.com' })).status, 403);
  // fetch 会忽略 Host 头覆盖，改用原始 http 请求验证伪造 Host
  const fakeHost = await new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: '/api/command', method: 'POST', headers: { Host: 'internal.example.com', Origin: EXT_ORIGIN, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.end(JSON.stringify({ command: 'getConfig' }));
  });
  assert.equal(fakeHost, 403);
});

test('命令接口：无令牌或令牌错误返回 401', async () => {
  assert.equal((await call({ command: 'getConfig' }, { token: null })).status, 401);
  assert.equal((await call({ command: 'getConfig' }, { token: '0'.repeat(64) })).status, 401);
});

test('首次认证绑定扩展 Origin，其他扩展即使持有令牌也被拒绝', async () => {
  const paired = await call({ command: 'getConfig' });
  assert.equal(paired.status, 200);
  const other = await call({ command: 'getConfig' }, { origin: OTHER_EXT_ORIGIN });
  assert.equal(other.status, 403);
  assert.match(other.json.error, /另一个扩展/);
});

test('未知命令被白名单拒绝', async () => {
  const r = await call({ command: 'publish', payload: {} });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /未知命令/);
});

test('请求大小按 UTF-8 字节限制，而不是按字符串字符数', async () => {
  const r = await call({ command: 'getConfig', payload: { padding: '中'.repeat(400000) } });
  assert.equal(r.status, 413);
});

test('setConfig：不存在目录报错且不创建；有效目录通过；嵌套拒绝', async () => {
  await fs.mkdir(ARCHIVE, { recursive: true });
  const bad = await call({ command: 'setConfig', payload: { unpublished: path.join(ROOT, '不存在的目录') } });
  assert.equal(bad.status, 422);
  assert.equal(fss.existsSync(path.join(ROOT, '不存在的目录')), false, '不创建目录');
  const unknown = await call({ command: 'setConfig', payload: { unpublished: UNPUB, published: PUB, run: 'publish' } });
  assert.equal(unknown.status, 422, '配置接口拒绝未知字段');
  const badExcelRel = await call({ command: 'setConfig', payload: { excelPath: '计划表.xlsx' } });
  assert.equal(badExcelRel.status, 422, 'Excel 路径必须是绝对路径');
  const badExcelExt = await call({ command: 'setConfig', payload: { excelPath: PLAN_TXT } });
  assert.equal(badExcelExt.status, 422, '登记表只接受 .xlsx 路径');
  const ok = await call({ command: 'setConfig', payload: { unpublished: UNPUB, published: PUB, archive: ARCHIVE, excelPath: PLAN_XLSX, excelSheet: '9月执行计划' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.excel.sheetName, '9月执行计划');
  assert.equal(ok.json.roots.archive, ARCHIVE);
  const cfg = await call({ command: 'getConfig' });
  assert.equal(cfg.json.excel.configured, true);
  assert.equal(cfg.json.excel.sheetName, '9月执行计划');
  assert.equal(cfg.json.roots.archive.configured, true);
  const nested = await call({ command: 'setConfig', payload: { unpublished: UNPUB, published: path.join(UNPUB, 'sub') } });
  assert.equal(nested.status, 422);
  const nestedArchive = await call({ command: 'setConfig', payload: { archive: path.join(UNPUB, '归档') } });
  assert.equal(nestedArchive.status, 422, '归档目标不能嵌套在未发布目录内');
});

let scanned = [];
test('scan：识别全部夹具包并报告预期问题；junction 被跳过', async () => {
  const r = await call({ command: 'scan', payload: { root: 'unpublished' } });
  assert.equal(r.status, 200);
  scanned = r.json.packages.filter((p) => p.packageId);
  const titles = scanned.map((p) => p.title);
  assert.ok(titles.includes('正常文章包'));
  assert.ok(titles.includes('中文路径 与空格·文章'), '中文与空格路径可扫描');
  assert.ok(!titles.includes('1-e.png') && !r.json.packages.some((p) => p.title === '外部目录'), 'junction 指向的外部包不被扫描');
  assert.ok(r.json.packages.some((p) => p.skippedLinks >= 1), 'junction 跳过有记录');

  const normal = scanned.find((p) => p.title === '正常文章包');
  assert.equal(normal.imageCount, 3);
  assert.equal(normal.issueCount, 0, `正常包不应有问题：${JSON.stringify(normal.issues)}`);
  const missing = scanned.find((p) => p.title === '缺图文章包');
  assert.ok(missing.issues.some((i) => i.includes('缺图') && i.includes('3-不存在.png')));
  const emptyAlt = scanned.find((p) => p.title === '空ALT文章包');
  assert.ok(emptyAlt.issues.some((i) => i.includes('ALT 为空')));
});

test('getPackage：返回图片/ALT/乱序说明；缺图与同名如实报告', async () => {
  const normal = scanned.find((p) => p.title === '正常文章包');
  const r = await call({ command: 'getPackage', payload: { packageId: normal.packageId } });
  assert.equal(r.status, 200);
  assert.equal(r.json.images.length, 3);
  assert.ok(r.json.images.every((i) => i.dataUrl.startsWith('data:image/png;base64,')));
  assert.equal(r.json.images[0].alt, 'ALT一');
  assert.equal(r.json.images.filter((i) => i.duplicateOf).length, 0);

  const disorder = scanned.find((p) => p.title === '乱序文章包');
  const r2 = await call({ command: 'getPackage', payload: { packageId: disorder.packageId } });
  assert.ok(r2.json.notes.some((n) => n.includes('乱序')), '乱序有说明');
  // 乱序时 ALT 仍按编号绑定：HTML 第 1 张是 3-c.png，其 ALT 应为 O3
  assert.equal(r2.json.images.find((i) => i.name === '3-c.png').alt, 'O3');

  const dup = scanned.find((p) => p.title === '重复图片文章包');
  const r3 = await call({ command: 'getPackage', payload: { packageId: dup.packageId } });
  const dupImg = r3.json.images.find((i) => i.name === '2-x.png');
  assert.equal(dupImg.duplicateOf, '1-x.png', '内容相同的图片被标记为重复');

  const sameName = scanned.find((p) => p.title === '同名文件文章包');
  const r4 = await call({ command: 'getPackage', payload: { packageId: sameName.packageId } });
  assert.ok(r4.json.issues.some((i) => i.includes('同名图片文件')), '同名图片有 issue');

  const caption = scanned.find((p) => p.title === '图注与ALT冲突包');
  const r5 = await call({ command: 'getPackage', payload: { packageId: caption.packageId } });
  assert.equal(r5.json.occurrences.length, 1);
  assert.equal(r5.json.occurrences[0].assetMatch, '正文文件名唯一匹配');
  assert.equal(r5.json.occurrences[0].manifestAlt, '清单 ALT');
  assert.equal(r5.json.occurrences[0].htmlAlt, 'HTML ALT');
  assert.equal(r5.json.occurrences[0].caption, '已有可见图注');
  assert.equal(r5.json.occurrences[0].altConflict, true);
  assert.ok(r5.json.issues.some((i) => i.includes('ALT 冲突')));
});

test('getPackage：伪造包 ID 被拒绝', async () => {
  const r = await call({ command: 'getPackage', payload: { packageId: 'pkg-000000000000000000000000' } });
  assert.equal(r.status, 422);
  const r2 = await call({ command: 'getPackage', payload: { packageId: '../../etc' } });
  assert.notEqual(r2.status, 200);
});

test('已发布目录独立扫描', async () => {
  const r = await call({ command: 'scan', payload: { root: 'published' } });
  assert.equal(r.status, 200);
  assert.equal(r.json.packages.filter((p) => p.packageId).length, 1);
});

test('服务重启后旧包 ID 失效（不复活旧授权）', async () => {
  const normal = scanned.find((p) => p.title === '正常文章包');
  // 结束当前服务并重启
  child.kill();
  await new Promise((r) => setTimeout(r, 500));
  await new Promise((resolve, reject) => {
    child = spawn(process.execPath, [path.join(import.meta.dirname, '..', 'server.mjs')], {
      env: { ...process.env, YIZ_DATA_DIR: DATA_DIR, YIZ_PORT: String(PORT) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', () => {});
    const wait = setInterval(async () => {
      try {
        const res = await fetch(`${BASE}/api/health`);
        if (res.ok) { clearInterval(wait); resolve(); }
      } catch { /* 未就绪 */ }
    }, 300);
    setTimeout(() => reject(new Error('重启超时')), 15000);
  });
  const r = await call({ command: 'getPackage', payload: { packageId: normal.packageId } });
  assert.equal(r.status, 422, '重启后旧 ID 应失效');
});

// 收尾
test.after?.(() => { child?.kill?.(); });
process.on('exit', () => { try { child?.kill?.(); } catch { /* 已退出 */ } });
