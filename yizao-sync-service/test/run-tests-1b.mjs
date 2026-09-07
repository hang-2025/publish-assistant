import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { inspectPackage } from '../lib/package.mjs';
import { buildSendSnapshot, makeTaskKey } from '../lib/snapshot.mjs';
import { TaskStore } from '../lib/tasks.mjs';
import { CrossProcessLock } from '../lib/mutex.mjs';
import {
  startSimulatedPublish, siteLockKey, validSiteKey,
  allowedSiteKeysForSegments, assertPackageSiteBinding,
} from '../lib/official-flow.mjs';
import { readXlsx, writeXlsx } from '../lib/xlsx.mjs';
import { zipStore, unzip, crc32 } from '../lib/zip.mjs';
import {
  resolvePlanRows, sniffColumnMapping, previewRegistration, classifyTaskId, normalizePl,
  PL_FORMAT_HINT,
} from '../lib/excel-mapping.mjs';
import {
  fileSha256, collectFiles, copyArchiveWithCheckpoints, archiveGateForSharedPackage,
  buildCopyPlan, makeOperationId, resolveArchivePaths, inspectTargetAgainstPlan,
} from '../lib/archive-sim.mjs';
import { checkRealActionGate, getCapabilities } from '../lib/capabilities.mjs';

/**
 * 阶段1B 测试：全部在系统临时目录中构造夹具，不读取、不修改真实文章目录与真实 Excel。
 * 覆盖：
 * - 不可变发送快照的门槛（缺图/同名冲突/ALT 冲突/空 ALT/读取失败 → 阻塞，不进入可执行状态）；
 *   官网/百家号默认无可见图注；ALT 与图注始终两个字段；
 * - 任务状态/幂等/恢复（任务键、双击防重、同账号单写、重启「结果待核对」不清自动重发、清理后重试）；
 * - 官网/百家号模拟状态机经服务命令走通到「等待用户最终提交（模拟）」；终态绝不自动发布；
 * - 跨进程站点锁：mock 执行器持锁时模拟停止（不并发写同一站点）；
 * - zip/.xlsx 只读往返、Excel 只读映射（PL 唯一/追加/冲突/需要绑定）；
 * - 归档恢复纯模拟：哈希校验中断保留源+已完成副本、目标已存在拒覆盖、检查点续传、多平台共享包门槛；
 * - 安全红测：日志不含正文/令牌；严格 schema 拒绝任意路径/URL/命令名。
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'yizao-1b-'));
const UNPUB = path.join(ROOT, '未发布');
const PUB = path.join(ROOT, '已发布');
const ARCHIVE = path.join(ROOT, '归档目标');
const PORT = 8792;
const DATA_DIR = path.join(ROOT, 'svc-data');
const LOCK_DIR = path.join(DATA_DIR, 'locks');
const PLAN_HTTP_XLSX = path.join(ROOT, '阶段1C登记预览.xlsx');
await fs.mkdir(PUB, { recursive: true });
await fs.mkdir(ARCHIVE, { recursive: true });
await fs.writeFile(PLAN_HTTP_XLSX, writeXlsx([{
  name: '9月执行计划',
  rows: [
    ['任务编号', '平台', '产品分类', '文章标题', '计划日期', '发布状态', '正式链接'],
    ['PL-2026-001', 'eyzao.com', '易造新闻', '官网正常包A', '2026-09-01', '未发布', ''],
    ['PL-2026-002', 'baijiahao', '易造新闻', '百家号正常包A', '2026-09-01', '未发布', ''],
    ['PL-2026-003', '官网', '易造新闻', '官网正常包A', '2026-09-02', '未发布', ''],
  ],
}]));

// ---------- 夹具：1x1 PNG ----------
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

/** 旧版官网/平台包夹具（01-SEO信息.txt + 03-图片ALT清单.txt + 02 正文 + 06-* 图片）。 */
async function makePackage(dir, { images, alts, htmlImgs, htmlAlts, captions, htmlOverride }) {
  await fs.mkdir(path.join(dir, '06-发布图片'), { recursive: true });
  await fs.writeFile(path.join(dir, '01-SEO信息.txt'),
    `内容栏目：易造新闻\n内容标题：${path.basename(dir)}\nSEO标题：${path.basename(dir)}\nSEO关键字：测试关键词\nSEO描述：测试描述\n`);
  if (alts) await fs.writeFile(path.join(dir, '03-图片ALT清单.txt'), alts.map((a, i) => `${i + 1}-img.png：${a}`).join('\n'));
  let html;
  if (htmlOverride) {
    html = htmlOverride;
  } else {
    const body = htmlImgs.map((n, i) => {
      const img = `<img src="06-发布图片/${n}" alt="${htmlAlts?.[i] ?? ''}">`;
      return captions?.[i] ? `<figure>${img}<figcaption>${captions[i]}</figcaption></figure>` : img;
    }).join('\n');
    html = `<!doctype html><html><body><p>开头段落</p>${body}</body></html>`;
  }
  await fs.writeFile(path.join(dir, '02-后台一键复制正文.html'), html);
  for (const [i, name] of images.entries()) {
    await fs.writeFile(path.join(dir, '06-发布图片', name), makePng(i + 1));
  }
}

const OFFICIAL_DIR = path.join(UNPUB, '官网', 'eyzao.com', '易造新闻', '2026-09-01');
await makePackage(path.join(OFFICIAL_DIR, '官网正常包A'), {
  images: ['1-img.png', '2-img.png', '3-img.png'],
  alts: ['ALT一', 'ALT二', 'ALT三'],
  htmlImgs: ['1-img.png', '2-img.png', '3-img.png'],
  htmlAlts: ['', '', ''],
});
await makePackage(path.join(UNPUB, '官网', 'eyzao.com', '易造新闻', '2026-09-02', '官网缺图包B'), {
  images: ['1-img.png', '2-img.png'],
  alts: ['B1', 'B2'],
  htmlImgs: ['1-img.png', '2-img.png', '3-不存在.png'],
});
await makePackage(path.join(UNPUB, '官网', 'eyzao.com', '易造新闻', '2026-09-03', '官网ALT冲突包C'), {
  images: ['1-img.png'],
  alts: ['清单 ALT'],
  htmlImgs: ['1-img.png'],
  htmlOverride: '<!doctype html><html><body><p>段落</p><figure><img src="06-发布图片/1-img.png" alt="HTML ALT"><figcaption>已有可见图注</figcaption></figure></body></html>',
});
// 同名图片：两个 06- 目录同名 → 无法唯一绑定
{
  const dir = path.join(UNPUB, '官网', 'eyzao.com', '易造新闻', '2026-09-04', '官网同名冲突包D');
  await makePackage(dir, { images: ['1-img.png'], alts: ['D1'], htmlImgs: ['1-img.png'] });
  await fs.mkdir(path.join(dir, '06-处理后图片-600x400'), { recursive: true });
  await fs.writeFile(path.join(dir, '06-处理后图片-600x400', '1-img.png'), makePng(9));
}
// 正文读图失败：图片文件超过 15MB，hashImageFile 读取阶段直接拒绝 → 快照阻塞「读取失败」
{
  const dir = path.join(UNPUB, '官网', 'eyzao.com', '易造新闻', '2026-09-05', '官网坏图包E');
  await makePackage(dir, { images: ['1-img.png'], alts: ['E1'], htmlImgs: ['1-img.png'] });
  await fs.writeFile(path.join(dir, '06-发布图片', '1-img.png'), Buffer.alloc(15 * 1024 * 1024 + 1, 7));
}
// 空 ALT（清单与 HTML 都没有）→ 阻塞「缺少 ALT」
await makePackage(path.join(UNPUB, '官网', 'eyzao.com', '易造新闻', '2026-09-06', '官网空ALT包F'), {
  images: ['1-img.png'], alts: [''], htmlImgs: ['1-img.png'],
});
// 真正的百家号夹具包（审查返工 P0-1.5：不再拿官网包冒充百家号包）
await makePackage(path.join(UNPUB, '主流平台', '百家号', '易造新闻', '2026-09-01', '百家号正常包A'), {
  images: ['1-img.png', '2-img.png'],
  alts: ['百家ALT一', '百家ALT二'],
  htmlImgs: ['1-img.png', '2-img.png'],
  htmlAlts: ['', ''],
});
// 知乎夹具：阶段2J只生成草稿平台的小样本验收材料，不调用任何平台接口。
await makePackage(path.join(UNPUB, '主流平台', '知乎', '智能防雷系统', '2026-09-01', '知乎验收包I'), {
  images: ['1-img.png'],
  alts: ['知乎测试 ALT'],
  htmlImgs: ['1-img.png'],
  htmlAlts: [''],
});
// 官网 eyzao.cn 夹具：用于验证「同是官网包也不能串站点」，以及站点锁互斥（未被任务键占用）
await makePackage(path.join(UNPUB, '官网', 'eyzao.cn', '易造新闻', '2026-09-02', '官网CN包H'), {
  images: ['1-img.png'],
  alts: ['HALt'],
  htmlImgs: ['1-img.png'],
  htmlAlts: [''],
});
// 目录惯例不符（首段既不是「官网」也不是「主流平台」）→ 服务端推导不出平台，一律拒绝
await makePackage(path.join(UNPUB, '未分类目录', 'eyzao.com', '易造新闻', '2026-09-07', '无法推导平台包G'), {
  images: ['1-img.png'], alts: ['G1'], htmlImgs: ['1-img.png'],
});

// ---------- 单元：不可变发送快照 ----------
async function snapshotFor(rel, opts) {
  const { absolutePath } = await (await import('../lib/security.mjs')).resolveInside(UNPUB, rel);
  const info = await inspectPackage(absolutePath);
  const readAsset = async (asset) => {
    const { absolutePath: safe } = await (await import('../lib/security.mjs')).resolveInside(UNPUB, `${rel}/${asset.dir}/${asset.name}`);
    const { hashImageFile } = await import('../lib/package.mjs');
    return hashImageFile(safe);
  };
  return buildSendSnapshot({ info, readAsset, source: { packageId: 'pkg-test', rootName: 'unpublished', relativePath: rel }, ...opts });
}

test('发送快照：正常官网包可执行；ALT 与图注两字段、不自动生成图注', async () => {
  const snap = await snapshotFor('官网/eyzao.com/易造新闻/2026-09-01/官网正常包A');
  assert.equal(snap.gate.executable, true, `应为可执行：${JSON.stringify(snap.gate)}`);
  assert.equal(snap.content.imageCount, 3);
  assert.equal(snap.assets.length, 3);
  assert.ok(snap.assets.every((a) => /^[0-9a-f]{64}$/.test(a.sha256)), '图片含 SHA-256');
  assert.equal(snap.content.title, '官网正常包A');
  assert.equal(snap.content.seoCategory, '易造新闻');
  assert.ok(snap.source.contentVersion, '内容版本非空');
  assert.equal(snap.occurrences.length, 3);
  for (const o of snap.occurrences) {
    assert.ok('caption' in o && 'effectiveAlt' in o, 'ALT 与图注始终是独立字段');
    assert.equal(o.caption, '', '官网/百家号默认不追加可见图注');
    assert.equal(o.captionSource, '', '无既有图注时不生成');
  }
});

test('发送快照：缺图 / ALT 冲突 / 空 ALT / 同名冲突 / 读图失败 → 阻塞，不进入可执行状态', async () => {
  const missing = await snapshotFor('官网/eyzao.com/易造新闻/2026-09-02/官网缺图包B');
  assert.equal(missing.gate.executable, false);
  assert.ok(missing.gate.blocks.some((b) => b.includes('缺图')));

  const conflict = await snapshotFor('官网/eyzao.com/易造新闻/2026-09-03/官网ALT冲突包C');
  assert.equal(conflict.gate.executable, false);
  assert.ok(conflict.gate.blocks.some((b) => b.includes('ALT 冲突')));
  assert.equal(conflict.occurrences[0].caption, '已有可见图注', '正文既有图注被如实保留为独立字段');

  const sameName = await snapshotFor('官网/eyzao.com/易造新闻/2026-09-04/官网同名冲突包D');
  assert.equal(sameName.gate.executable, false);
  assert.ok(sameName.gate.blocks.some((b) => b.includes('同名')));

  const bad = await snapshotFor('官网/eyzao.com/易造新闻/2026-09-05/官网坏图包E');
  assert.equal(bad.gate.executable, false);
  assert.ok(bad.gate.blocks.some((b) => b.includes('读取失败')), `读取失败应阻塞：${JSON.stringify(bad.gate)}`);

  const emptyAlt = await snapshotFor('官网/eyzao.com/易造新闻/2026-09-06/官网空ALT包F');
  assert.equal(emptyAlt.gate.executable, false);
  assert.ok(emptyAlt.gate.blocks.some((b) => b.includes('缺少 ALT')), `空 ALT 应阻塞：${JSON.stringify(emptyAlt.gate)}`);
});

// ---------- 单元：发布包 ↔ 目标平台的服务端绑定（审查返工 P0-1） ----------
test('包↔平台推导：官网段取域名、主流平台段取平台；目录不符时推导不出平台', () => {
  const official = allowedSiteKeysForSegments(['官网', 'eyzao.com', '易造新闻', '2026-09-01', '包A']);
  assert.deepEqual(official.siteKeys, ['eyzao.com']);
  assert.equal(official.reason, 'ok');

  const bjh = allowedSiteKeysForSegments(['主流平台', '百家号', '易造新闻', '2026-09-01', '包A']);
  assert.deepEqual(bjh.siteKeys, ['baijiahao']);

  // 官网包绝不允许多站点，百家号包也绝不允许被当成官网包
  assert.ok(!official.siteKeys.includes('baijiahao'));
  assert.ok(!bjh.siteKeys.includes('eyzao.com'));

  for (const segs of [['未分类目录', 'eyzao.com', '包'], ['官网', 'unknown-domain.com', '包'], []] ) {
    const r = allowedSiteKeysForSegments(segs);
    assert.deepEqual(r.siteKeys, [], `应推导不出平台：${segs.join('/')}`);
    assert.ok(r.reason, '必须给出人工可读的原因');
  }
});

test('assertPackageSiteBinding：不匹配/推导不出时抛错，匹配时返回分段', () => {
  const officialRel = '官网/eyzao.com/易造新闻/2026-09-01/官网正常包A';
  assert.throws(
    () => assertPackageSiteBinding({ packageId: 'pkg-1', relativePath: officialRel, siteKey: 'baijiahao' }),
    /发布包与目标平台不匹配/,
    '官网包不能走百家号流程',
  );
  assert.throws(
    () => assertPackageSiteBinding({ packageId: 'pkg-2', relativePath: '主流平台/百家号/易造新闻/2026-09-01/百家号正常包A', siteKey: 'eyzao.com' }),
    /发布包与目标平台不匹配/,
    '百家号包不能走官网流程',
  );
  assert.throws(
    () => assertPackageSiteBinding({ packageId: 'pkg-3', relativePath: '未分类目录/eyzao.com/包G', siteKey: 'eyzao.com' }),
    /无法从该包的受控目录推导目标平台/,
  );
  const ok = assertPackageSiteBinding({ packageId: 'pkg-4', relativePath: officialRel, siteKey: 'eyzao.com' });
  assert.deepEqual(ok.allowedSiteKeys, ['eyzao.com']);
  assert.equal(ok.segments[0], '官网');
});

// ---------- 单元：任务存储（幂等/恢复） ----------
const storeDir = path.join(ROOT, 'tasks');
await fs.mkdir(storeDir, { recursive: true });
const store = new TaskStore(storeDir);
const baseInput = {
  packageId: 'pkg-aaa', rootName: 'unpublished', relativePath: '官网/eyzao.com/易造新闻/2026-09-01/官网正常包A',
  platform: 'eyzao.com', platformName: '官网 · EmCms', platformKind: 'official',
  accountId: 'eyzao.com-占位账号', accountLabel: '官网 · EmCms 账号（占位）',
  contentVersion: 'v'.repeat(64), contentVersionShort: 'v'.repeat(12),
  title: '官网正常包A', segments: ['官网', 'eyzao.com', '易造新闻', '2026-09-01', '官网正常包A'],
  snapshotId: 'snap-test', mode: 'simulate',
};

test('任务键幂等：双击不重复创建', async () => {
  const key = makeTaskKey({ packageId: 'pkg-aaa', platform: 'eyzao.com', accountId: 'eyzao.com-占位账号', contentVersion: 'v'.repeat(64) });
  const first = await store.createTask({ ...baseInput, taskKey: key });
  assert.equal(first.created, true);
  const second = await store.createTask({ ...baseInput, taskKey: key });
  assert.equal(second.created, false);
  assert.equal(second.reason, 'exists');
  assert.equal((await store.listTasks()).filter((t) => t.taskKey === key).length, 1);
  await store.removeTask(first.task.taskId);
});

test('同账号同时只允许一个进行中的写任务', async () => {
  const key1 = makeTaskKey({ packageId: 'pkg-aaa', platform: 'eyzao.com', accountId: 'eyzao.com-占位账号', contentVersion: 'h1'.repeat(32) });
  const t1 = await store.createTask({ ...baseInput, taskKey: key1, title: 'A' });
  assert.equal(t1.created, true);
  const key2 = makeTaskKey({ packageId: 'pkg-bbb', platform: 'eyzao.com', accountId: 'eyzao.com-占位账号', contentVersion: 'h2'.repeat(32) });
  const t2 = await store.createTask({ ...baseInput, taskKey: key2, packageId: 'pkg-bbb', title: 'B' });
  assert.equal(t2.created, false);
  assert.equal(t2.reason, 'account-busy');
  assert.equal(t2.busy.taskId, t1.task.taskId);
  await store.removeTask(t1.task.taskId);
});

test('重启恢复：中间态标记「结果待核对（重启中断）」，绝不自动重发；清理后可重试', async () => {
  const key = makeTaskKey({ packageId: 'pkg-ccc', platform: 'baijiahao', accountId: 'baijiahao-占位账号', contentVersion: 'r'.repeat(64) });
  const t = await store.createTask({ ...baseInput, taskKey: key, platform: 'baijiahao', platformName: '百家号', platformKind: 'baijiahao', accountId: 'baijiahao-占位账号', contentVersion: 'r'.repeat(64) });
  assert.equal(t.created, true);
  await store.updateStage(t.task.taskId, '模拟填写后台', '中途');
  // 新实例 = 服务重启
  const store2 = new TaskStore(storeDir);
  const changed = await store2.recoverInterrupted();
  assert.ok(changed >= 1);
  const stalled = await store2.getTask(t.task.taskId);
  assert.equal(stalled.states.draft.stage, '结果待核对（重启中断）');
  assert.equal(stalled.runState, 'stalled');
  const again = await store2.createTask({ ...baseInput, taskKey: key, platform: 'baijiahao', platformName: '百家号', platformKind: 'baijiahao', accountId: 'baijiahao-占位账号', contentVersion: 'r'.repeat(64) });
  assert.equal(again.created, false, '中断结果未核对前不得自动重发');
  assert.equal(again.reason, 'stalled');
  assert.equal(again.task.taskId, t.task.taskId);
  const rm = await store2.removeTask(t.task.taskId);
  assert.equal(rm.removed, true, '纯模拟未发布任务可清理');
  const retry = await store2.createTask({ ...baseInput, taskKey: key, platform: 'baijiahao', platformName: '百家号', platformKind: 'baijiahao', accountId: 'baijiahao-占位账号', contentVersion: 'r'.repeat(64) });
  assert.equal(retry.created, true, '清理中断记录后可重新模拟');
  await store2.removeTask(retry.task.taskId);
});

test('removeTask：涉及真实状态的记录不可删除', async () => {
  const key = makeTaskKey({ packageId: 'pkg-ddd', platform: 'eyzao.com', accountId: 'eyzao.com-占位账号', contentVersion: 'x'.repeat(64) });
  const t = await store.createTask({ ...baseInput, taskKey: key, title: 'D' });
  const task = await store.getTask(t.task.taskId);
  task.mode = 'real';
  task.states.publish = { status: '已正式发布', detail: '', updatedAt: task.updatedAt };
  await store.saveTask(task);
  const rm = await store.removeTask(t.task.taskId);
  assert.equal(rm.removed, false);
  assert.match(rm.reason, /不允许/);
  // 清理夹具
  task.mode = 'simulate'; task.states.publish = { status: '未发布', detail: '', updatedAt: task.updatedAt };
  await store.saveTask(task);
  await store.removeTask(t.task.taskId);
});

// ---------- 单元：官网/百家号模拟状态机（不经过 HTTP） ----------
/**
 * 等待某个锁目录里的站点锁真正被释放。
 * startSimulatedPublish 在终态之后才异步释放锁，前一个用例若不显式等待，
 * 下一个用例会撞上还没释放完的锁（这是测试自身的时序缺陷，不是产品逻辑）。
 */
async function waitLockFree(lockDir, siteKey, timeout = 5000) {
  if (!lockDir) return;
  const probe = new CrossProcessLock(lockDir, siteLockKey(siteKey));
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await probe.acquire('test-probe')) { await probe.release(); return; }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`锁 ${siteLockKey(siteKey)} 在 ${timeout}ms 内未释放`);
}
let lastFlowLockDir = '';

test('startSimulatedPublish：推进到终态「等待用户最终提交（模拟）」，未发布/未登记/未归档', async () => {
  const d = await fs.mkdtemp(path.join(ROOT, 'flow-'));
  const s = new TaskStore(path.join(d, 'tasks'));
  const locks = path.join(d, 'locks');
  lastFlowLockDir = locks;
  await fs.mkdir(locks, { recursive: true });
  const snap = await snapshotFor('官网/eyzao.com/易造新闻/2026-09-01/官网正常包A');
  assert.ok(validSiteKey('eyzao.com'));
  const start = await startSimulatedPublish({ store: s, snapshot: snap, siteKey: 'eyzao.com', lockDir: locks });
  assert.equal(start.created, true);
  // 等待终态
  let task = await s.getTask(start.taskId);
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && task?.runState !== 'terminal') {
    await new Promise((r) => setTimeout(r, 60));
    task = await s.getTask(start.taskId);
  }
  assert.ok(task, '任务存在');
  assert.equal(task.states.draft.stage, '等待用户最终提交（模拟）');
  assert.equal(task.runState, 'terminal');
  assert.equal(task.states.publish.status, '未发布');
  assert.equal(task.states.excel.status, '未登记');
  assert.equal(task.states.archive.status, '未归档');
  assert.match(task.states.draft.detail, /未上传、未发布、未登记 Excel、未归档/);
  assert.match(task.states.draft.detail, /用户/); // 保留给人工最终提交
});

test('startSimulatedPublish：同键已存在（含已核对）不重复跑；站内并发被拒绝', async () => {
  await waitLockFree(lastFlowLockDir, 'eyzao.com');
  const d = await fs.mkdtemp(path.join(ROOT, 'flow2-'));
  const s = new TaskStore(path.join(d, 'tasks'));
  const locks = path.join(d, 'locks');
  await fs.mkdir(locks, { recursive: true });
  const snap = await snapshotFor('官网/eyzao.com/易造新闻/2026-09-01/官网正常包A');
  const one = await startSimulatedPublish({ store: s, snapshot: snap, siteKey: 'eyzao.com', lockDir: locks });
  assert.equal(one.started, true, JSON.stringify(one));
  // 等它结束并释放锁，再模拟一次同键 → exists，不重跑
  let task = await s.getTask(one.taskId);
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && task?.runState !== 'terminal') { await new Promise((r) => setTimeout(r, 60)); task = await s.getTask(one.taskId); }
  await waitLockFree(locks, 'eyzao.com');
  const again = await startSimulatedPublish({ store: s, snapshot: snap, siteKey: 'eyzao.com', lockDir: locks });
  assert.equal(again.created, false);
  assert.equal(again.reason, 'exists');
  assert.equal(again.task.taskId, one.taskId);
});

// 锁的作用域（审查返工 P0-2）：以下两条只证明「遵循同一文件锁协议的新服务进程之间互斥」，
// 不能据此声称与未接入该协议的旧执行器互斥。
test('startSimulatedPublish：锁被占用时不创建任务、直接停止（新服务进程之间不并发写同一站点）', async () => {
  const d = await fs.mkdtemp(path.join(ROOT, 'flow3-'));
  const s = new TaskStore(path.join(d, 'tasks'));
  const locks = path.join(d, 'locks');
  await fs.mkdir(locks, { recursive: true });
  const snap = await snapshotFor('官网/eyzao.com/易造新闻/2026-09-01/官网正常包A');
  const other = new CrossProcessLock(locks, siteLockKey('eyzao.com'));
  assert.equal(await other.acquire('other-holder'), true);
  const start = await startSimulatedPublish({ store: s, snapshot: snap, siteKey: 'eyzao.com', lockDir: locks });
  assert.equal(start.created, false);
  assert.equal(start.reason, 'site-lock-busy');
  assert.equal((await s.listTasks()).length, 0, '锁被占用时不残留任何任务');
  await other.release();
});

// ---------- 单元：zip / xlsx 只读往返 ----------
/** 构造 method 0/8 的 zip（mirror lib/zip.mjs 的字节布局，用于覆盖 deflate 读取）。 */
function zipMake(entries) {
  const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n, 0); return b; };
  const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n, 0); return b; };
  const parts = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data), 'utf8');
    const method = entry.method === 8 ? 8 : 0;
    const stored = method === 0 ? data : zlib.deflateRawSync(data);
    const name = Buffer.from(entry.name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]), u16(20), u16(0), u16(method), u16(0), u16(0),
      u32(crc), u32(stored.length), u32(data.length),
      u16(name.length), u16(0), name,
    ]);
    parts.push(local, stored);
    const cd = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x01, 0x02]), u16(20), u16(20), u16(0), u16(method), u16(0), u16(0),
      u32(crc), u32(stored.length), u32(data.length),
      u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), name,
    ]);
    central.push(cd);
    offset += local.length + stored.length;
  }
  const centralDir = Buffer.concat(central);
  const eocd = Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x05, 0x06]), u16(0), u16(0), u16(entries.length), u16(entries.length),
    u32(centralDir.length), u32(offset), u16(0),
  ]);
  return Buffer.concat([...parts, centralDir, eocd]);
}

test('zip store/deflate 往返与 CRC 校验', async () => {
  const zipBuf = zipStore([
    { name: 'a.txt', data: '易造 内容' },
    { name: 'b/图片.png', data: Buffer.from([1, 2, 3]) },
  ]);
  const back = unzip(zipBuf);
  assert.equal(back.get('a.txt').toString('utf8'), '易造 内容');
  assert.deepEqual([...back.get('b/图片.png')], [1, 2, 3]);
  // 真实 Excel 常用 deflate(method 8)：构造后仍可读（覆盖 deflate 解压分支）
  const mixed = zipMake([
    { name: 'c.txt', data: 'deflate 文本：易造', method: 8 },
    { name: 'd.bin', data: Buffer.from([9, 8, 7]), method: 8 },
    { name: 'e.txt', data: 'store 文本', method: 0 },
  ]);
  const mback = unzip(mixed);
  assert.equal(mback.get('c.txt').toString('utf8'), 'deflate 文本：易造');
  assert.deepEqual([...mback.get('d.bin')], [9, 8, 7]);
  assert.equal(mback.get('e.txt').toString('utf8'), 'store 文本');
});

test('xlsx 读写往返：计划表（含中文/PL-*/空单元格）保留', async () => {
  const buf = writeXlsx([{
    name: '官网日执行表',
    rows: [
      ['任务编号', '平台', '产品分类', '文章标题', '计划日期'],
      ['PL-2026-001', '官网', '易造新闻', '标题一', '2026-09-01'],
      ['PL-2026-002', '百家号', '易造新闻', '标题二', ''],
      [],
      ['', '', ''],
    ],
  }]);
  const wb = readXlsx(buf);
  assert.equal(wb.sheets.length, 1);
  assert.equal(wb.sheets[0].name, '官网日执行表');
  const rows = wb.sheets[0].rows;
  assert.equal(rows[0][0], '任务编号');
  assert.equal(rows[1][0], 'PL-2026-001');
  assert.equal(rows[1][1], '官网');
  assert.equal(rows[1][3], '标题一');
  assert.ok(rows[1][4] !== undefined);
});

test('Excel 只读映射：PL 唯一命中 / 0 行追加 / 多行冲突 / 缺 PL 需要绑定；无任何写操作', async () => {
  const buf = writeXlsx([{
    name: '计划表',
    rows: [
      ['任务编号', '平台', '产品分类', '文章标题', '计划日期'],
      ['PL-2026-001', '官网', '易造新闻', '标题一', '2026-09-01'],
      ['PL-2026-002', '官网', '易造新闻', '标题二', '2026-09-01'],
      ['PL-2026-002', '百家号', '易造新闻', '标题二B', '2026-09-01'],
      ['PL-2026-003', '官网', '易造新闻', '标题三-重复1', '2026-09-01'],
      ['PL-2026-003', '官网', '易造新闻', '标题三-重复2', '2026-09-01'],
    ],
  }]);
  const wb = readXlsx(buf);
  const target = wb.sheets[0];
  const sniffed = sniffColumnMapping(target.rows);
  assert.ok(sniffed.matched.includes('taskId') && sniffed.matched.includes('platform'));

  const unique = resolvePlanRows({ rows: target.rows, query: { plTaskId: 'pl-2026-001', platform: '官网' } });
  assert.equal(unique.kind, 'unique');
  assert.equal(unique.matched.taskId, 'PL-2026-001');

  // 同平台同 PL 有两行 → 立即停止（绝不猜测写入哪一行）
  const dup = resolvePlanRows({ rows: target.rows, query: { plTaskId: 'PL-2026-003', platform: '官网' } });
  assert.equal(dup.kind, 'conflict');
  assert.equal(dup.rows.length, 2);
  // 跨平台同名任务编号 + 给了平台 → 平台限定后是唯一命中（不算冲突）
  const cross = resolvePlanRows({ rows: target.rows, query: { plTaskId: 'PL-2026-002', platform: '官网' } });
  assert.equal(cross.kind, 'unique');
  assert.equal(cross.matched.title, '标题二');

  const append = resolvePlanRows({ rows: target.rows, query: { plTaskId: 'PL-2026-009', platform: '官网', title: '新文章', category: '易造新闻' } });
  assert.equal(append.kind, 'append');
  assert.equal(append.appendRow.taskId, 'PL-2026-009');
  assert.equal(append.appendRow.platform, '官网');
  assert.match(append.notice, /尚未写入/);

  const noPl = resolvePlanRows({ rows: target.rows, query: { platform: '官网' } });
  assert.equal(noPl.kind, 'needs-binding');

  // previewRegistration 也是只读：不落盘
  const prev = previewRegistration({ workbook: wb, sheetName: '计划表', query: { plTaskId: 'PL-2026-001', platform: '官网' } });
  assert.equal(prev.ok, true);
  assert.equal(prev.readOnly, true);
  assert.equal(prev.resolution.kind, 'unique');
});

// ---------- 审查返工 P1-1：任务编号格式 / 空平台 / 列映射冲突 ----------
test('P1-1：PL- 空编号与非法格式不是合法任务编号；格式提示可用', () => {
  assert.equal(classifyTaskId('').code, 'missing-task-id');
  assert.equal(classifyTaskId('   ').code, 'missing-task-id');
  assert.equal(classifyTaskId('PL-').code, 'empty-pl-number', 'PL- 空编号绝不合法');
  assert.equal(classifyTaskId('PL- ').code, 'empty-pl-number');
  assert.equal(classifyTaskId('PL').code, 'empty-pl-number');
  assert.equal(classifyTaskId('PL-2026').code, 'invalid-task-id');
  assert.equal(classifyTaskId('PL-ABC-001').code, 'invalid-task-id');
  assert.equal(classifyTaskId('2026-001').code, 'invalid-task-id');
  assert.equal(classifyTaskId('pl-2026-001').code, 'ok');
  assert.equal(classifyTaskId('pl-2026-001').normalized, 'PL-2026-001');
  assert.equal(classifyTaskId('PL-2026-1').code, 'ok');
  assert.equal(classifyTaskId('PL-2026-0012').code, 'ok');
  assert.equal(classifyTaskId('PL-2026-001-A1').code, 'ok');
  assert.equal(normalizePl('PL-'), '', 'normalizePl 不返回空编号');
  assert.match(PL_FORMAT_HINT, /^PL-YYYY-N/);
});

test('P1-1：查询指定平台时，平台为空的行必须返回「需要人工绑定」，不得静默命中', () => {
  const buf = writeXlsx([{
    name: '计划表',
    rows: [
      ['任务编号', '平台', '产品分类', '文章标题'],
      ['PL-2026-010', '', '易造新闻', '平台为空的标题'],
      ['PL-2026-011', '官网', '易造新闻', '正常标题'],
    ],
  }]);
  const rows = readXlsx(buf).sheets[0].rows;
  const blank = resolvePlanRows({ rows, query: { plTaskId: 'PL-2026-010', platform: '官网' } });
  assert.equal(blank.kind, 'needs-binding', '不得把空平台行当唯一命中');
  assert.equal(blank.code, 'blank-platform');
  assert.equal(blank.rows.length, 1);
  assert.match(blank.notice, /平台.*为空|人工绑定/);
  assert.equal(blank.matched, null);

  // 同一编号、平台明确的行仍然唯一命中
  const ok = resolvePlanRows({ rows, query: { plTaskId: 'PL-2026-011', platform: '官网' } });
  assert.equal(ok.kind, 'unique');
  assert.equal(ok.matched.title, '正常标题');
});

test('P1-1：任务编号缺失/非法时返回需要绑定，不继续猜行', () => {
  const buf = writeXlsx([{
    name: '计划表',
    rows: [
      ['任务编号', '平台', '文章标题'],
      ['PL-2026-020', '官网', '标题20'],
    ],
  }]);
  const rows = readXlsx(buf).sheets[0].rows;
  for (const [value, code] of [['', 'missing-task-id'], ['PL-', 'empty-pl-number'], ['PL-乱码', 'invalid-task-id']]) {
    const r = resolvePlanRows({ rows, query: { plTaskId: value, platform: '官网' } });
    assert.equal(r.kind, 'needs-binding', `「${value}」应先要求绑定`);
    assert.equal(r.code, code);
    assert.equal(r.matched, null);
  }
});

test('P1-1：多候选表头/一列多义/多个表头行 → 列映射冲突，要求人工确认，绝不自动猜列', () => {
  // ① 一个字段匹配到多列（平台 / 平台名称）
  const dupRows = [
    ['任务编号', '平台', '平台名称', '文章标题'],
    ['PL-2026-030', '官网', '官网', '标题30'],
  ];
  const dupSniff = sniffColumnMapping(dupRows);
  assert.ok(dupSniff.conflicts.some((c) => c.type === 'multiple-columns' && c.role === 'platform'));
  assert.equal(dupSniff.mapping.platform, undefined, '冲突字段不得进入自动映射');
  const dup = resolvePlanRows({ rows: dupRows, query: { plTaskId: 'PL-2026-030', platform: '官网' } });
  assert.equal(dup.kind, 'column-conflict');
  assert.equal(dup.code, 'column-mapping-conflict');
  assert.match(dup.notice, /列映射冲突|人工指定列/);

  // ② 一列同时像两个字段（「平台状态」既有平台关键词也有状态关键词）
  const multiRows = [
    ['任务编号', '平台状态', '文章标题'],
    ['PL-2026-031', '官网', '标题31'],
  ];
  const multiSniff = sniffColumnMapping(multiRows);
  assert.ok(multiSniff.conflicts.some((c) => c.type === 'column-claims-multiple-roles' && c.roles.includes('platform')));
  const multi = resolvePlanRows({ rows: multiRows, query: { plTaskId: 'PL-2026-031', platform: '官网' } });
  assert.equal(multi.kind, 'column-conflict', '一列多义必须停');

  // ③ 表头行之后又出现一行很像表头 → 表头不确定
  const twoHeaderRows = [
    ['任务编号', '平台', '文章标题'],
    ['任务编号', '平台', '文章标题'],
    ['PL-2026-032', '官网', '标题32'],
  ];
  const two = resolvePlanRows({ rows: twoHeaderRows, query: { plTaskId: 'PL-2026-032', platform: '官网' } });
  assert.equal(two.kind, 'column-conflict');
  assert.ok(two.conflicts.some((c) => c.type === 'multiple-header-rows'));

  // ④ previewRegistration 也要把冲突带出来
  const wb = { sheets: [{ name: '计划表', rows: dupRows }] };
  const prev = previewRegistration({ workbook: wb, query: { plTaskId: 'PL-2026-030', platform: '官网' } });
  assert.equal(prev.columnMapPreview.ok, false);
  assert.ok(prev.columnMapPreview.conflicts.length >= 1);
  assert.equal(prev.resolution.kind, 'column-conflict');
  assert.equal(prev.readOnly, true, '冲突时依然是只读，不写入任何单元格');
});

// ---------- 单元：归档恢复纯模拟 ----------
async function writeTree(root, map) {
  for (const [rel, content] of Object.entries(map)) {
    const p = path.join(root, rel);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, content);
  }
}

test('归档纯模拟：复制+校验成功、目标已存在拒覆盖、已存在完成标记幂等', async () => {
  const d = await fs.mkdtemp(path.join(ROOT, 'arc-'));
  const src = path.join(d, 'src');
  const tgt = path.join(d, 'tgt');
  const ck = path.join(d, 'ck');
  await writeTree(src, { '正文.html': '正文内容', '06-发布图片/1-a.png': 'PNGDATA1', '06-发布图片/2-b.png': 'PNGDATA2' });
  const r1 = await copyArchiveWithCheckpoints({ sourceDir: src, targetDir: tgt, checkpointDir: ck });
  assert.equal(r1.ok, true, r1.reason || '');
  assert.equal(r1.copied.length, 3);
  // 完成标记幂等
  const r2 = await copyArchiveWithCheckpoints({ sourceDir: src, targetDir: tgt, checkpointDir: ck });
  assert.equal(r2.ok, true);
  assert.equal(r2.alreadyComplete, true);
  assert.equal(r2.copied.length, 0);
  // 目标哈希与源一致
  const srcFiles = await collectFiles(src);
  const tgtFiles = await collectFiles(tgt);
  assert.equal(srcFiles.size, tgtFiles.size);
  for (const [rel, buf] of srcFiles) assert.equal(fileSha256(buf), fileSha256(tgtFiles.get(rel)), rel);
  // 已存在非空目标 → 拒绝覆盖
  const tgt2 = path.join(d, 'tgt2');
  await writeTree(tgt2, { '已有.txt': '别覆盖我' });
  const r3 = await copyArchiveWithCheckpoints({ sourceDir: src, targetDir: tgt2, checkpointDir: ck });
  assert.equal(r3.ok, false);
  assert.match(r3.reason, /拒绝覆盖/);
});

test('归档纯模拟：校验不一致中断 → 保留源与已完成副本，检查点可续传', async () => {
  const d = await fs.mkdtemp(path.join(ROOT, 'arc2-'));
  const src = path.join(d, 'src');
  const tgt = path.join(d, 'tgt');
  const ck = path.join(d, 'ck');
  await writeTree(src, { 'a.txt': 'AAA', 'b.txt': 'BBB', 'c.txt': 'CCC' });
  // onCopied 在第 2 个文件完成后篡改第 3 个源文件 → 哈希不一致，模拟中断
  const r = await copyArchiveWithCheckpoints({
    sourceDir: src, targetDir: tgt, checkpointDir: ck,
    onCopied: async (rel) => {
      if (rel === 'b.txt') await fs.writeFile(path.join(src, 'c.txt'), '篡改');
    },
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /哈希不一致/);
  // 源未被删除；已完成副本 a/b 保留
  assert.ok((await collectFiles(src)).has('a.txt'));
  assert.ok((await fs.stat(path.join(tgt, 'a.txt'))));
  assert.ok((await fs.stat(path.join(tgt, 'b.txt'))));
  assert.equal((await fs.readFile(path.join(tgt, 'c.txt'), 'utf8').catch(() => null)), null, 'c 未写入');
  // 恢复源文件内容后，检查点续传完成全部
  await fs.writeFile(path.join(src, 'c.txt'), 'CCC');
  const r2 = await copyArchiveWithCheckpoints({ sourceDir: src, targetDir: tgt, checkpointDir: ck });
  assert.equal(r2.ok, true, r2.reason || '');
  assert.equal(r2.resumed, true);
  const srcFiles = await collectFiles(src);
  const tgtFiles = await collectFiles(tgt);
  assert.equal(srcFiles.size, tgtFiles.size);
});

// ---------- 单元：归档恢复纯模拟（审查返工 P0-3 新增回归） ----------
test('归档 P0-3：完成后删除/篡改/新增目标文件 → 完成标记不得盲信成功', async () => {
  const d = await fs.mkdtemp(path.join(ROOT, 'arc3-'));
  const src = path.join(d, 'src');
  const tgt = path.join(d, 'tgt');
  const ck = path.join(d, 'ck');
  await writeTree(src, { 'a.txt': 'AAA', 'sub/b.txt': 'BBB' });
  const first = await copyArchiveWithCheckpoints({ sourceDir: src, targetDir: tgt, checkpointDir: ck });
  assert.equal(first.ok, true, first.reason || '');
  const again = await copyArchiveWithCheckpoints({ sourceDir: src, targetDir: tgt, checkpointDir: ck });
  assert.equal(again.ok, true);
  assert.equal(again.verified, true, '重复执行必须重新核验而不是直接报成功');

  // ① 删除一个目标文件
  await fs.rm(path.join(tgt, 'a.txt'));
  const missing = await copyArchiveWithCheckpoints({ sourceDir: src, targetDir: tgt, checkpointDir: ck });
  assert.equal(missing.ok, false, '完成标记存在但文件被删，绝不能报成功');
  assert.match(missing.reason, /完成标记存在但目标校验失败/);
  assert.match(missing.reason, /缺少/);
  assert.equal(missing.needsManual, true);

  // 恢复后仍可完成
  await fs.writeFile(path.join(tgt, 'a.txt'), 'AAA');
  const fixed = await copyArchiveWithCheckpoints({ sourceDir: src, targetDir: tgt, checkpointDir: ck });
  assert.equal(fixed.ok, true, fixed.reason || '');

  // ② 篡改目标文件内容
  await fs.writeFile(path.join(tgt, 'sub', 'b.txt'), '被篡改');
  const tampered = await copyArchiveWithCheckpoints({ sourceDir: src, targetDir: tgt, checkpointDir: ck });
  assert.equal(tampered.ok, false);
  assert.match(tampered.reason, /篡改|不一致/);
  await fs.writeFile(path.join(tgt, 'sub', 'b.txt'), 'BBB');

  // ③ 目标多出计划外文件
  await fs.writeFile(path.join(tgt, '多余.txt'), '不该出现');
  const extra = await copyArchiveWithCheckpoints({ sourceDir: src, targetDir: tgt, checkpointDir: ck });
  assert.equal(extra.ok, false);
  assert.match(extra.reason, /计划外的文件/);
});

test('归档 P0-3：首次复制后、检查点写入前中断 → 安全续跑，不覆盖已复制文件', async () => {
  const d = await fs.mkdtemp(path.join(ROOT, 'arc4-'));
  const src = path.join(d, 'src');
  const tgt = path.join(d, 'tgt');
  const ck = path.join(d, 'ck');
  await writeTree(src, { 'a.txt': 'AAA', 'b.txt': 'BBB', 'c.txt': 'CCC' });
  const r = await copyArchiveWithCheckpoints({
    sourceDir: src, targetDir: tgt, checkpointDir: ck,
    onCopied: async () => { throw new Error('模拟：复制完成但检查点尚未写入即中断'); },
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /模拟：复制完成但检查点尚未写入即中断/);
  // 没有任何检查点/完成标记写入（中断发生在首次写检查点之前）
  assert.equal((await fs.readdir(ck)).filter((n) => n.endsWith('.json')).length, 0, '中断后没有残留检查点');
  assert.equal((await collectFiles(tgt)).size, 1, '目标保留已复制的第一个文件');

  const again = await copyArchiveWithCheckpoints({ sourceDir: src, targetDir: tgt, checkpointDir: ck });
  assert.equal(again.ok, true, again.reason || '');
  assert.equal(again.recoveredPartial, true, '应识别为“部分复制且无检查点”的安全恢复');
  assert.equal(again.resumed, false);
  const srcFiles = await collectFiles(src);
  const tgtFiles = await collectFiles(tgt);
  assert.equal(srcFiles.size, tgtFiles.size);
  for (const [rel, buf] of srcFiles) assert.equal(fileSha256(buf), fileSha256(tgtFiles.get(rel)), rel);
});

test('归档 P0-3：复制已完成但完成标记未写入 → 核验哈希后补写完成标记，绝不重复复制/覆盖', async () => {
  const d = await fs.mkdtemp(path.join(ROOT, 'arc5-'));
  const src = path.join(d, 'src');
  const tgt = path.join(d, 'tgt');
  const ck = path.join(d, 'ck');
  await writeTree(src, { 'a.txt': 'AAA', 'sub/b.txt': 'BBB' });
  // 手工模拟“文件都复制完了，但进程在写完成标记前死了”
  await fs.mkdir(path.join(tgt, 'sub'), { recursive: true });
  await fs.copyFile(path.join(src, 'a.txt'), path.join(tgt, 'a.txt'));
  await fs.copyFile(path.join(src, 'sub', 'b.txt'), path.join(tgt, 'sub', 'b.txt'));
  const r = await copyArchiveWithCheckpoints({ sourceDir: src, targetDir: tgt, checkpointDir: ck });
  assert.equal(r.ok, true, r.reason || '');
  assert.equal(r.recoveredUncheckpointed, true);
  assert.equal(r.verified, true);
  assert.equal(r.copied.length, 0, '不重复复制');
  assert.ok((await fs.readdir(ck)).some((n) => n.endsWith('.done.json')), '补写了完成标记');
  // 目标已存在同名但内容不同 → 拒绝覆盖
  const d2 = await fs.mkdtemp(path.join(ROOT, 'arc5b-'));
  await writeTree(path.join(d2, 'src'), { 'a.txt': 'AAA' });
  await writeTree(path.join(d2, 'tgt'), { 'a.txt': '别的内容' });
  const r2 = await copyArchiveWithCheckpoints({
    sourceDir: path.join(d2, 'src'), targetDir: path.join(d2, 'tgt'), checkpointDir: path.join(d2, 'ck'),
  });
  assert.equal(r2.ok, false);
  assert.match(r2.reason, /拒绝覆盖/);
  assert.equal((await fs.readFile(path.join(d2, 'tgt', 'a.txt'), 'utf8')), '别的内容', '绝不覆盖既有文件');
});

test('归档 P0-3：错用其他任务的检查点 / 源计划变化后复用旧检查点 → 停止并报告', async () => {
  const d = await fs.mkdtemp(path.join(ROOT, 'arc6-'));
  const src = path.join(d, 'src');
  const tgt = path.join(d, 'tgt');
  const ck = path.join(d, 'ck');
  await fs.mkdir(ck, { recursive: true });
  await writeTree(src, { 'a.txt': 'AAA', 'b.txt': 'BBB', 'c.txt': 'CCC' });

  // 先制造一个“别的任务”的检查点：不同目标目录 = 不同操作
  const otherPlan = await buildCopyPlan({ sourceDir: src, targetDir: path.join(d, '别的目录'), checkpointDir: ck });
  const currentPlan = await buildCopyPlan({ sourceDir: src, targetDir: tgt, checkpointDir: ck });
  assert.notEqual(otherPlan.operationId, currentPlan.operationId, '不同目标 = 不同操作 ID');

  const progressName = `${currentPlan.operationId}.progress.json`;
  await fs.writeFile(path.join(ck, progressName), JSON.stringify({
    schema: 2, operationId: otherPlan.operationId, planSummary: otherPlan.planSummary,
    source: otherPlan.source, target: otherPlan.target, copied: ['a.txt', 'b.txt'],
  }));
  const wrong = await copyArchiveWithCheckpoints({ sourceDir: src, targetDir: tgt, checkpointDir: ck });
  assert.equal(wrong.ok, false, '错用其他任务检查点必须停止');
  assert.match(wrong.reason, /属于另一次归档操作/);
  assert.equal(wrong.needsManual, true);
  assert.equal(fss.existsSync(path.join(tgt, 'a.txt')), false, '拒绝后不复制任何文件');

  // 源计划变化：源文件增减导致 operationId 变化，旧检查点不再适用
  await fs.rm(path.join(ck, progressName), { force: true });
  const before = await buildCopyPlan({ sourceDir: src, targetDir: tgt, checkpointDir: ck });
  await fs.writeFile(path.join(src, 'd.txt'), 'DDD');
  const after = await buildCopyPlan({ sourceDir: src, targetDir: tgt, checkpointDir: ck });
  assert.notEqual(before.operationId, after.operationId, '源计划变化 → 操作 ID 变化');
  await fs.writeFile(path.join(ck, `${after.operationId}.progress.json`), JSON.stringify({
    schema: 2, operationId: before.operationId, planSummary: before.planSummary,
    source: before.source, target: before.target, copied: ['a.txt'],
  }));
  const stale = await copyArchiveWithCheckpoints({ sourceDir: src, targetDir: tgt, checkpointDir: ck });
  assert.equal(stale.ok, false);
  assert.match(stale.reason, /属于另一次归档操作|源\/目标或文件清单不一致/);
  // schema 版本不符同样拒绝
  await fs.writeFile(path.join(ck, `${after.operationId}.progress.json`), JSON.stringify({ schema: 1, operationId: after.operationId, copied: [] }));
  const oldSchema = await copyArchiveWithCheckpoints({ sourceDir: src, targetDir: tgt, checkpointDir: ck });
  assert.equal(oldSchema.ok, false);
  assert.match(oldSchema.reason, /版本不一致/);
});

test('归档 P0-3：junction/符号链接越界与源/目标嵌套一律拒绝', async () => {
  const d = await fs.mkdtemp(path.join(ROOT, 'arc7-'));
  const outside = path.join(d, '外部');
  await writeTree(outside, { 'secret.txt': '不该被归档' });
  const src = path.join(d, 'src');
  await writeTree(src, { 'a.txt': 'AAA' });

  // ① 源目录内出现 junction → 拒绝执行（不跟随、不复制）
  await fs.symlink(outside, path.join(src, 'link-外部'), 'junction');
  const withLink = await copyArchiveWithCheckpoints({
    sourceDir: src, targetDir: path.join(d, 'tgt1'), checkpointDir: path.join(d, 'ck1'),
  });
  assert.equal(withLink.ok, false);
  assert.match(withLink.reason, /符号链接\/junction/);
  await fs.rm(path.join(src, 'link-外部'), { force: true });

  // ② 目标目录本身是 junction → 拒绝（写入会被重定向到目录之外）
  const tgtLink = path.join(d, 'tgt-link');
  await fs.symlink(outside, tgtLink, 'junction');
  const toLink = await copyArchiveWithCheckpoints({
    sourceDir: src, targetDir: tgtLink, checkpointDir: path.join(d, 'ck2'),
  });
  assert.equal(toLink.ok, false);
  assert.match(toLink.reason, /符号链接\/junction/);

  // ③ 源 = 目标 / 目标嵌套在源内 / 检查点在目标内
  await assert.rejects(() => resolveArchivePaths({ sourceDir: src, targetDir: src, checkpointDir: path.join(d, 'ck3') }), /不能相同/);
  await assert.rejects(() => resolveArchivePaths({ sourceDir: src, targetDir: path.join(src, 'inner'), checkpointDir: path.join(d, 'ck3') }), /不能位于源目录之内/);
  await assert.rejects(() => resolveArchivePaths({ sourceDir: src, targetDir: path.join(d, 'tgt3'), checkpointDir: path.join(d, 'tgt3', 'ck') }), /检查点目录不能位于归档目标之内/);
  // 计划构建也走同一套边界校验
  await assert.rejects(() => buildCopyPlan({ sourceDir: src, targetDir: src, checkpointDir: path.join(d, 'ck3') }), /不能相同/);
});

test('归档 P0-3：inspectTargetAgainstPlan 区分一致/不一致/计划外/链接', async () => {
  const d = await fs.mkdtemp(path.join(ROOT, 'arc8-'));
  const src = path.join(d, 'src');
  const tgt = path.join(d, 'tgt');
  await writeTree(src, { 'a.txt': 'AAA', 'b.txt': 'BBB' });
  await writeTree(tgt, { 'a.txt': 'AAA', 'b.txt': '被改了', '多余.txt': 'x' });
  const plan = await buildCopyPlan({ sourceDir: src, targetDir: tgt, checkpointDir: path.join(d, 'ck') });
  const state = await inspectTargetAgainstPlan(plan);
  assert.deepEqual(state.matching, ['a.txt']);
  assert.deepEqual(state.mismatch, ['b.txt']);
  assert.deepEqual(state.extra, ['多余.txt']);
  const op = makeOperationId(plan);
  assert.match(op.operationId, /^op-[0-9a-f]{24}$/);
  assert.equal(op.planSummary.length, 64);
});

test('多平台共享包归档门槛：任一平台未人工确认发布 → 不归档；全部满足 → ready', () => {
  const notReady = archiveGateForSharedPackage({
    packageId: 'pkg-x',
    requiredPlatforms: [
      { platform: 'zhihu', platformName: '知乎', publishStatus: '人工确认已发布' },
      { platform: 'sohu', platformName: '搜狐', publishStatus: '未发布', draftStage: '模拟提交草稿' },
    ],
  });
  assert.equal(notReady.ready, false);
  assert.ok(notReady.reasons.some((r) => r.includes('搜狐')));
  const ready = archiveGateForSharedPackage({
    packageId: 'pkg-x',
    requiredPlatforms: [
      { platform: 'zhihu', platformName: '知乎', publishStatus: '人工确认已发布' },
      { platform: 'sohu', platformName: '搜狐', publishStatus: '已正式发布' },
    ],
  });
  assert.equal(ready.ready, true);
});

test('1D 能力矩阵与真实动作闸门：默认拒绝，只有显式 Stage 3 知乎草稿例外', () => {
  const caps = getCapabilities();
  assert.equal(caps.realActionsEnabled, false);
  assert.ok(caps.platforms.some((p) => p.id === 'eyzao.com' && p.status === 'simulation-ready'));
  assert.ok(caps.platforms.some((p) => p.id === 'toutiao' && p.status === 'not-adapted'));
  for (const action of ['upload', 'publish', 'excelWrite', 'archiveMove']) {
    const gate = checkRealActionGate({ action, platform: 'eyzao.com' });
    assert.equal(gate.allowed, false, `${action} 当前必须关闭`);
    assert.match(gate.reason, /真实动作默认关闭|只读\/模拟/);
  }
  const unknown = checkRealActionGate({ action: 'deleteAll', platform: 'eyzao.com' });
  assert.equal(unknown.allowed, false);
  assert.equal(unknown.policy, 'unknown-action');
});

// ---------- HTTP 服务：官网/百家号骨架命令 ----------
let child;
let token = '';
await new Promise((resolve, reject) => {
  child = spawn(process.execPath, [path.join(__dirname, '..', 'server.mjs')], {
    env: { ...process.env, YIZ_DATA_DIR: DATA_DIR, YIZ_PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; const m = out.match(/[0-9a-f]{64}/); if (m) { token = m[0]; resolve(); } });
  child.stderr.on('data', (d) => process.stderr.write(d));
  child.on('error', reject);
  setTimeout(() => reject(new Error('服务启动超时')), 15000);
});
process.on('exit', () => { try { child?.kill?.(); } catch { /* 已退出 */ } });

const BASE = `http://127.0.0.1:${PORT}`;
const EXT = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
async function call(body, { origin = EXT, tk = token } = {}) {
  const headers = { 'Content-Type': 'application/json', Origin: origin, Authorization: `Bearer ${tk}` };
  const res = await fetch(`${BASE}/api/command`, { method: 'POST', headers, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json() };
}

test('1B HTTP：配对 + setConfig + scan 夹具', async () => {
  assert.equal((await call({ command: 'setConfig', payload: { unpublished: UNPUB, published: PUB, archive: ARCHIVE, excelPath: PLAN_HTTP_XLSX, excelSheet: '9月执行计划' } })).status, 200);
  const scan = await call({ command: 'scan', payload: { root: 'unpublished' } });
  assert.equal(scan.status, 200);
  assert.ok(scan.json.packages.length >= 4, `应扫描到官网夹具包：${scan.json.packages.map((p) => p.title).join(',')}`);
  const list = await call({ command: 'getTasks' });
  assert.equal(list.status, 200);
  assert.equal(list.json.count, 0);
});

const scannedRef = { map: new Map() };
test('1B HTTP：prepareOfficialTask 只生成预览，不创建任务', async () => {
  const scan = await call({ command: 'scan', payload: { root: 'unpublished' } });
  for (const p of scan.json.packages) scannedRef.map.set(p.title, p);
  const pkg = scannedRef.map.get('官网正常包A');
  assert.ok(pkg, '正常包已扫描');
  const r = await call({ command: 'prepareOfficialTask', payload: { packageId: pkg.packageId, siteKey: 'eyzao.com' } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.mode, 'preview');
  assert.equal(r.json.preview.simulatedOnly, true);
  assert.equal(r.json.preview.finalAction, '等待用户最终提交（模拟）——绝不自动发布');
  assert.equal(r.json.preview.gate.executable, true);
  assert.ok(r.json.snapshot.snapshotId);
  assert.ok(r.json.taskKey.includes('eyzao.com'));
  // 没创建任何任务
  const tasks = await call({ command: 'getTasks' });
  assert.equal(tasks.json.count, 0);
});

test('1B HTTP：simulateOfficialTask 走通到「等待用户最终提交（模拟）」；任务键与预览一致', async () => {
  const pkg = scannedRef.map.get('官网正常包A');
  const preview = await call({ command: 'prepareOfficialTask', payload: { packageId: pkg.packageId, siteKey: 'eyzao.com' } });
  const r = await call({ command: 'simulateOfficialTask', payload: { packageId: pkg.packageId, siteKey: 'eyzao.com' } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.mode, 'simulate');
  assert.equal(r.json.started, true);
  assert.equal(r.json.task.taskKey, preview.json.taskKey);
  assert.equal(r.json.task.contentVersion, preview.json.snapshot.contentVersion);
  assert.equal(r.json.task.platform, 'eyzao.com');
  assert.match(r.json.task.accountLabel, /占位/);
  const tid = r.json.task.taskId;
  // 等待终态
  let t;
  let lastResp;
  const deadline = Date.now() + 6000;
  do {
    await new Promise((res) => setTimeout(res, 120));
    lastResp = await call({ command: 'getTask', payload: { taskId: tid } });
    t = lastResp.json.task;
  } while (Date.now() < deadline && t?.runState !== 'terminal');
  assert.ok(t, `未等到终态，最后响应：${lastResp.status} ${JSON.stringify(lastResp.json)}`);
  assert.equal(t.draft.stage, '等待用户最终提交（模拟）');
  assert.match(t.draft.detail, /未上传、未发布/);
  assert.equal(t.publish.status, '未发布');
  assert.equal(t.excel.status, '未登记');
  assert.equal(t.archive.status, '未归档');
  // 重复模拟同键 → 不重跑
  const again = await call({ command: 'simulateOfficialTask', payload: { packageId: pkg.packageId, siteKey: 'eyzao.com' } });
  assert.equal(again.json.started, false);
  assert.equal(again.json.reason, 'exists');
  assert.equal(again.json.task.taskId, tid);
});

test('1B HTTP：阻塞的包不创建模拟任务（缺图）', async () => {
  const pkg = scannedRef.map.get('官网缺图包B');
  const r = await call({ command: 'simulateOfficialTask', payload: { packageId: pkg.packageId, siteKey: 'eyzao.com' } });
  assert.equal(r.status, 200);
  assert.equal(r.json.mode, 'blocked');
  assert.equal(r.json.gate.executable, false);
  const tasks = await call({ command: 'getTasks' });
  assert.ok(!tasks.json.tasks.some((x) => x.packageId === pkg.packageId));
});

test('1B HTTP：百家号包走百家号站点 → 走到「等待用户最终提交（模拟）」终态', async () => {
  // 审查返工 P0-1.5：这里必须用真正的百家号夹具包，不再拿官网包冒充。
  const pkg = scannedRef.map.get('百家号正常包A');
  assert.ok(pkg, '百家号夹具包已扫描到');
  const r = await call({ command: 'simulateOfficialTask', payload: { packageId: pkg.packageId, siteKey: 'baijiahao' } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.started, true);
  const tid = r.json.task.taskId;
  let t;
  const deadline = Date.now() + 6000;
  do {
    await new Promise((res) => setTimeout(res, 120));
    t = (await call({ command: 'getTask', payload: { taskId: tid } })).json.task;
  } while (Date.now() < deadline && t?.runState !== 'terminal');
  assert.equal(t.draft.stage, '等待用户最终提交（模拟）');
  assert.equal(t.platform, 'baijiahao');
  assert.match(t.platformName, /百家号/);
});

test('1B HTTP 回归（P0-1）：官网包请求百家号 / 百家号包请求官网 / 目录推导不出平台 → 全部拒绝且不创建任务', async () => {
  const official = scannedRef.map.get('官网正常包A');
  const bjh = scannedRef.map.get('百家号正常包A');
  const unbound = scannedRef.map.get('无法推导平台包G');
  assert.ok(official && bjh && unbound, '三个夹具包都已扫描');
  const countBefore = (await call({ command: 'getTasks' })).json.count;

  const cases = [
    ['官网包 → 百家号', official, 'baijiahao', /发布包与目标平台不匹配/],
    ['百家号包 → 官网', bjh, 'eyzao.com', /发布包与目标平台不匹配/],
    ['百家号包 → 另一个官网', bjh, 'eyzao.cn', /发布包与目标平台不匹配/],
    ['官网 eyzao.cn 包 → eyzao.com', scannedRef.map.get('官网CN包H'), 'eyzao.com', /发布包与目标平台不匹配/],
    ['目录推导不出平台', unbound, 'eyzao.com', /无法从该包的受控目录推导目标平台/],
  ];
  for (const [label, pkg, siteKey, re] of cases) {
    for (const command of ['prepareOfficialTask', 'simulateOfficialTask']) {
      const r = await call({ command, payload: { packageId: pkg.packageId, siteKey } });
      assert.equal(r.status, 422, `${label} / ${command} 应被拒绝：${JSON.stringify(r.json)}`);
      assert.match(r.json.error, re, `${label} / ${command}`);
    }
  }
  const after = await call({ command: 'getTasks' });
  assert.equal(after.json.count, countBefore, '被拒绝的请求不得创建任何任务');
});

test('1B HTTP 回归（P0-1）：正确组合仍然通过（官网→官网、百家号→百家号）', async () => {
  const official = scannedRef.map.get('官网正常包A');
  const bjh = scannedRef.map.get('百家号正常包A');
  const okOfficial = await call({ command: 'prepareOfficialTask', payload: { packageId: official.packageId, siteKey: 'eyzao.com' } });
  assert.equal(okOfficial.status, 200, JSON.stringify(okOfficial.json));
  assert.equal(okOfficial.json.preview.siteKey, 'eyzao.com');
  const okBjh = await call({ command: 'prepareOfficialTask', payload: { packageId: bjh.packageId, siteKey: 'baijiahao' } });
  assert.equal(okBjh.status, 200, JSON.stringify(okBjh.json));
  assert.equal(okBjh.json.preview.siteKey, 'baijiahao');
  assert.equal(okBjh.json.preview.platform, 'baijiahao');
  // 预览里的站点只能是服务端推导出来的那个
  assert.equal(okOfficial.json.taskKey.includes('eyzao.com'), true);
  assert.equal(okBjh.json.taskKey.includes('baijiahao'), true);
});

test('1C HTTP：previewExcelRegistration 只读预览台账匹配，不创建任务、不写 Excel', async () => {
  const official = scannedRef.map.get('官网正常包A');
  assert.ok(official, '官网包已扫描');
  const beforeTasks = (await call({ command: 'getTasks' })).json.count;
  const beforeBytes = await fs.readFile(PLAN_HTTP_XLSX);

  const unique = await call({ command: 'previewExcelRegistration', payload: { packageId: official.packageId, siteKey: 'eyzao.com', plTaskId: 'PL-2026-001' } });
  assert.equal(unique.status, 200, JSON.stringify(unique.json));
  assert.equal(unique.json.mode, 'excel-registration-preview');
  assert.equal(unique.json.readOnly, true);
  assert.equal(unique.json.registration.readOnly, true);
  assert.equal(unique.json.registration.resolution.kind, 'unique');
  assert.equal(unique.json.registration.resolution.matched.taskId, 'PL-2026-001');

  const append = await call({ command: 'previewExcelRegistration', payload: { packageId: official.packageId, siteKey: 'eyzao.com', plTaskId: 'PL-2026-999' } });
  assert.equal(append.status, 200, JSON.stringify(append.json));
  assert.equal(append.json.registration.resolution.kind, 'append');
  assert.equal(append.json.registration.resolution.appendRow.taskId, 'PL-2026-999');
  assert.match(append.json.registration.resolution.notice, /尚未写入/);

  const wrongSite = await call({ command: 'previewExcelRegistration', payload: { packageId: official.packageId, siteKey: 'baijiahao', plTaskId: 'PL-2026-001' } });
  assert.equal(wrongSite.status, 422);
  assert.match(wrongSite.json.error, /发布包与目标平台不匹配/);

  const afterTasks = (await call({ command: 'getTasks' })).json.count;
  assert.equal(afterTasks, beforeTasks, '只读预览不得创建任务');
  assert.deepEqual(await fs.readFile(PLAN_HTTP_XLSX), beforeBytes, '只读预览不得改写 Excel');
});

test('1D HTTP：getCapabilities 展示能力；checkRealActionGate 默认拒绝真实发布/写表/归档', async () => {
  const caps = await call({ command: 'getCapabilities', payload: {} });
  assert.equal(caps.status, 200, JSON.stringify(caps.json));
  assert.equal(caps.json.realActionsEnabled, false);
  assert.ok(caps.json.platforms.some((p) => p.id === 'zhihu' && p.status === 'guarded-draft-unverified'));
  assert.ok(caps.json.platforms.some((p) => p.id === 'xiaohongshu' && p.status === 'not-adapted'));

  for (const action of ['publish', 'excelWrite', 'archiveMove']) {
    const gate = await call({ command: 'checkRealActionGate', payload: { action, platform: 'eyzao.com' } });
    assert.equal(gate.status, 200, JSON.stringify(gate.json));
    assert.equal(gate.json.allowed, false);
    assert.match(gate.json.reason, /真实动作默认关闭|只读\/模拟/);
  }
  const badParam = await call({ command: 'checkRealActionGate', payload: { action: 'publish', platform: 'eyzao.com', url: 'https://example.com' } });
  assert.equal(badParam.status, 422, '真实闸门也必须严格 schema，不能偷塞 URL/命令');
});

test('2A HTTP：preflightPackage 汇总快照/Excel/归档/真实动作闸门，仍然只读不执行', async () => {
  const official = scannedRef.map.get('官网正常包A');
  assert.ok(official, '官网包已扫描');
  const beforeTasks = (await call({ command: 'getTasks' })).json.count;
  const beforeExcel = await fs.readFile(PLAN_HTTP_XLSX);

  const r = await call({ command: 'preflightPackage', payload: { packageId: official.packageId, siteKey: 'eyzao.com', plTaskId: 'PL-2026-001' } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.mode, 'preflight');
  assert.equal(r.json.readOnly, true);
  assert.equal(r.json.snapshot.gate.executable, true);
  assert.equal(r.json.registration.status, 'unique');
  assert.equal(r.json.archive.configured, true);
  assert.equal(r.json.archive.targetRoot, ARCHIVE);
  assert.equal(r.json.gates.publish.allowed, false);
  assert.equal(r.json.gates.excelWrite.allowed, false);
  assert.equal(r.json.gates.archiveMove.allowed, false);
  assert.equal(r.json.summary.executableInThisBuild, false);
  assert.match(r.json.notice, /未上传、未公开发布、未写 Excel、未移动/);

  const wrongSite = await call({ command: 'preflightPackage', payload: { packageId: official.packageId, siteKey: 'baijiahao', plTaskId: 'PL-2026-001' } });
  assert.equal(wrongSite.status, 422);
  assert.match(wrongSite.json.error, /发布包与目标平台不匹配/);

  assert.equal((await call({ command: 'getTasks' })).json.count, beforeTasks, '总预演不得创建任务');
  assert.deepEqual(await fs.readFile(PLAN_HTTP_XLSX), beforeExcel, '总预演不得改写 Excel');
});

test('2I/2J HTTP：generateRealExecutionChecklist 生成可导出的只读验收材料，不创建任务、不写 Excel、不开放真实动作', async () => {
  const official = scannedRef.map.get('官网正常包A');
  const bjh = scannedRef.map.get('百家号正常包A');
  const zhihu = scannedRef.map.get('知乎验收包I');
  assert.ok(official && bjh && zhihu, '官网、百家号和知乎包已扫描');
  const beforeTasks = (await call({ command: 'getTasks' })).json.count;
  const beforeExcel = await fs.readFile(PLAN_HTTP_XLSX);
  const beforeArchive = await fs.readdir(ARCHIVE);

  const r = await call({ command: 'generateRealExecutionChecklist', payload: { packageId: official.packageId, siteKey: 'eyzao.com', plTaskId: 'PL-2026-001' } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.mode, 'real-execution-checklist');
  assert.equal(r.json.readOnly, true);
  assert.equal(r.json.summary.executableInThisBuild, false);
  assert.equal(r.json.summary.allowedRealActions, 0);
  assert.equal(r.json.summary.closedRealActions, 4);
  assert.match(r.json.checklistMarkdown, /真实执行验收单（只读预览）/);
  assert.match(r.json.checklistMarkdown, /官网正常包A|标题/);
  assert.match(r.json.checklistMarkdown, /发送快照/);
  assert.match(r.json.checklistMarkdown, /Excel 登记/);
  assert.match(r.json.checklistMarkdown, /真实动作闸门/);
  assert.match(r.json.acceptanceTemplateMarkdown, /易造官网（eyzao\.com） · 单篇小样本验收模板/);
  assert.match(r.json.acceptanceTemplateMarkdown, /独立 Chrome 资料目录/);
  assert.match(r.json.acceptanceTemplateMarkdown, /测试 Excel 副本/);
  assert.match(r.json.acceptanceTemplateMarkdown, /助手不得点击最终发布/);
  assert.match(r.json.exportMarkdown, /---/);
  assert.match(r.json.exportMarkdown, /真实执行验收单/);
  assert.match(r.json.exportMarkdown, /单篇小样本验收模板/);
  assert.match(r.json.exportFileName, /^yizao-acceptance-eyzao\.com-[a-z0-9-]{12}\.md$/);
  assert.match(r.json.notice, /未上传、未公开发布、未写 Excel、未移动/);

  const bjhResult = await call({ command: 'generateRealExecutionChecklist', payload: { packageId: bjh.packageId, siteKey: 'baijiahao', plTaskId: 'PL-2026-002' } });
  assert.equal(bjhResult.status, 200, JSON.stringify(bjhResult.json));
  assert.match(bjhResult.json.acceptanceTemplateMarkdown, /百家号 · 单篇小样本验收模板/);
  assert.match(bjhResult.json.acceptanceTemplateMarkdown, /停在最终提交按钮之前/);
  assert.match(bjhResult.json.exportFileName, /^yizao-acceptance-baijiahao-[a-z0-9-]{12}\.md$/);

  const zhihuResult = await call({ command: 'generateRealExecutionChecklist', payload: { packageId: zhihu.packageId, platform: 'zhihu' } });
  assert.equal(zhihuResult.status, 200, JSON.stringify(zhihuResult.json));
  assert.match(zhihuResult.json.acceptanceTemplateMarkdown, /知乎 · 单篇小样本验收模板/);
  assert.match(zhihuResult.json.acceptanceTemplateMarkdown, /测试 Excel 副本/);
  assert.match(zhihuResult.json.exportFileName, /^yizao-acceptance-zhihu-[a-z0-9-]{12}\.md$/);

  const mismatchedDraft = await call({ command: 'generateRealExecutionChecklist', payload: { packageId: official.packageId, platform: 'zhihu' } });
  assert.equal(mismatchedDraft.status, 422);
  assert.match(mismatchedDraft.json.error, /发布包与目标平台不匹配/);

  const wrongSite = await call({ command: 'generateRealExecutionChecklist', payload: { packageId: official.packageId, siteKey: 'baijiahao', plTaskId: 'PL-2026-001' } });
  assert.equal(wrongSite.status, 422);
  assert.match(wrongSite.json.error, /发布包与目标平台不匹配/);

  const sneaky = await call({ command: 'generateRealExecutionChecklist', payload: { packageId: official.packageId, siteKey: 'eyzao.com', command: 'publishNow' } });
  assert.equal(sneaky.status, 422, '验收单命令也必须严格 schema，不能偷塞真实命令');
  assert.equal((await call({ command: 'getTasks' })).json.count, beforeTasks, '生成验收单不得创建任务');
  assert.deepEqual(await fs.readFile(PLAN_HTTP_XLSX), beforeExcel, '生成验收单不得改写 Excel');
  assert.deepEqual(await fs.readdir(ARCHIVE), beforeArchive, '生成验收单不得改动归档目录');
});

test('2B HTTP：配置模板不导出个人路径/令牌；导入团队规则后平台别名可只读匹配 Excel', async () => {
  const official = scannedRef.map.get('官网正常包A');
  assert.ok(official, '官网包已扫描');
  const beforeConfig = await call({ command: 'getConfig' });
  assert.equal(beforeConfig.status, 200, JSON.stringify(beforeConfig.json));
  const beforeExcel = await fs.readFile(PLAN_HTTP_XLSX);

  const exported = await call({ command: 'getShareableConfigTemplate', payload: {} });
  assert.equal(exported.status, 200, JSON.stringify(exported.json));
  const exportedText = JSON.stringify(exported.json.template);
  assert.equal(exportedText.includes(ROOT), false, '模板不得包含临时个人根目录');
  assert.equal(exportedText.includes(PLAN_HTTP_XLSX), false, '模板不得包含 Excel 真实文件路径');
  assert.equal(exportedText.includes(token), false, '模板不得包含配对令牌');
  assert.ok(exported.json.excluded.includes('roots.unpublished'));
  assert.ok(exported.json.excluded.includes('excel.planPath'));

  const imported = await call({
    command: 'importShareableConfigTemplate',
    payload: {
      template: {
        schema: 'yizao-config-template',
        version: 2,
        excel: { sheetName: '9月执行计划' },
        mappings: { platformValues: { 'eyzao.com': ['官网', 'eyzao.com', 'www.eyzao.com'] } },
        captionPolicy: {
          official: 'keep-existing-only',
          baijiahao: 'keep-existing-only',
          draft: 'use-existing-alt-after-preview',
        },
      },
    },
  });
  assert.equal(imported.status, 200, JSON.stringify(imported.json));
  assert.equal(imported.json.imported, true);

  const afterConfig = await call({ command: 'getConfig' });
  assert.equal(afterConfig.json.roots.unpublished.resolved, beforeConfig.json.roots.unpublished.resolved, '导入模板不得改个人目录');
  assert.equal(afterConfig.json.excel.resolved, beforeConfig.json.excel.resolved, '导入模板不得改 Excel 文件路径');
  assert.ok(afterConfig.json.mappings.platformValues['eyzao.com'].includes('官网'));
  assert.equal(afterConfig.json.captionPolicy.official, 'keep-existing-only');

  const preview = await call({ command: 'previewExcelRegistration', payload: { packageId: official.packageId, siteKey: 'eyzao.com', plTaskId: 'PL-2026-003' } });
  assert.equal(preview.status, 200, JSON.stringify(preview.json));
  assert.equal(preview.json.registration.resolution.kind, 'unique');
  assert.equal(preview.json.registration.usedPlatformValue, '官网');
  assert.deepEqual(await fs.readFile(PLAN_HTTP_XLSX), beforeExcel, '2B 只读匹配仍不得改写 Excel');

  const badTemplate = await call({ command: 'importShareableConfigTemplate', payload: { template: { schema: 'evil', version: 2 } } });
  assert.equal(badTemplate.status, 422);
});

test('2C HTTP：共享包归档门槛只读预览，草稿/模拟完成不等于可归档', async () => {
  const official = scannedRef.map.get('官网正常包A');
  assert.ok(official, '官网包已扫描');
  const beforeTasks = (await call({ command: 'getTasks' })).json.count;
  const beforeExcel = await fs.readFile(PLAN_HTTP_XLSX);

  const r = await call({
    command: 'previewArchiveGate',
    payload: {
      packageId: official.packageId,
      requiredPlatforms: [
        { platform: 'eyzao.com', platformName: '易造官网' },
        { platform: 'zhihu', platformName: '知乎' },
      ],
    },
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.mode, 'archive-gate-preview');
  assert.equal(r.json.readOnly, true);
  assert.equal(r.json.gate.ready, false);
  assert.match(r.json.gate.reasons.join('\n'), /易造官网：尚未人工确认正式发布/);
  assert.match(r.json.gate.reasons.join('\n'), /知乎：缺少任务状态/);
  assert.match(r.json.notice, /未复制、未移动、未删除/);

  const inferred = await call({ command: 'previewArchiveGate', payload: { packageId: official.packageId } });
  assert.equal(inferred.status, 200, JSON.stringify(inferred.json));
  assert.ok(inferred.json.requiredPlatforms.some((p) => p.platform === 'eyzao.com'));

  const badPayload = await call({ command: 'previewArchiveGate', payload: { packageId: official.packageId, requiredPlatforms: 'zhihu' } });
  assert.equal(badPayload.status, 422);
  const badPlatform = await call({ command: 'previewArchiveGate', payload: { packageId: official.packageId, requiredPlatforms: [{ platform: '../zhihu' }] } });
  assert.equal(badPlatform.status, 422);
  const sneaky = await call({ command: 'previewArchiveGate', payload: { packageId: official.packageId, requiredPlatforms: [{ platform: 'zhihu', path: 'C:\\real' }] } });
  assert.equal(sneaky.status, 422);

  assert.equal((await call({ command: 'getTasks' })).json.count, beforeTasks, '归档门槛预览不得创建任务');
  assert.deepEqual(await fs.readFile(PLAN_HTTP_XLSX), beforeExcel, '归档门槛预览不得改写 Excel');
});

test('2D HTTP：模拟人工确认发布结果，只改任务状态，不写 Excel、不归档，发布后记录不可随意删除', async () => {
  const official = scannedRef.map.get('官网正常包A');
  assert.ok(official, '官网包已扫描');
  const beforeExcel = await fs.readFile(PLAN_HTTP_XLSX);
  const tasksBefore = await call({ command: 'getTasks' });
  const task = tasksBefore.json.tasks.find((t) => t.packageId === official.packageId && t.platform === 'eyzao.com');
  assert.ok(task, '官网模拟任务已存在');

  const confirmed = await call({
    command: 'confirmPublishedSimulated',
    payload: { taskId: task.taskId, publicUrl: 'https://www.eyzao.com/news/demo.html', note: '截图验收通过' },
  });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.json));
  assert.equal(confirmed.json.simulatedOnly, true);
  assert.equal(confirmed.json.task.publish.status, '人工确认已发布');
  assert.equal(confirmed.json.task.excel.status, '未登记');
  assert.equal(confirmed.json.task.archive.status, '未归档');
  assert.match(confirmed.json.notice, /未打开平台、未点击发布、未写 Excel、未移动/);

  const gate = await call({
    command: 'previewArchiveGate',
    payload: { packageId: official.packageId, requiredPlatforms: [{ platform: 'eyzao.com', platformName: '易造官网' }] },
  });
  assert.equal(gate.status, 200, JSON.stringify(gate.json));
  assert.equal(gate.json.gate.ready, true, '单平台要求在人工确认后可进入后续归档确认，但仍未归档');

  const remove = await call({ command: 'removeTask', payload: { taskId: task.taskId } });
  assert.equal(remove.status, 422, '带人工确认发布状态的历史记录不得直接删除');
  assert.match(remove.json.error, /涉及真实发布\/登记\/归档状态|不允许直接删除记录/);

  const badUrl = await call({ command: 'confirmPublishedSimulated', payload: { taskId: task.taskId, publicUrl: 'file:///C:/real.html' } });
  assert.equal(badUrl.status, 422);
  const sneaky = await call({ command: 'confirmPublishedSimulated', payload: { taskId: task.taskId, publicUrl: 'https://example.com/x', path: 'C:\\real' } });
  assert.equal(sneaky.status, 422);
  assert.deepEqual(await fs.readFile(PLAN_HTTP_XLSX), beforeExcel, '确认发布模拟不得改写 Excel');
});

test('2E HTTP：模拟人工确认 Excel 登记，必须先发布确认，不写真实 Excel、不触发归档', async () => {
  const official = scannedRef.map.get('官网正常包A');
  const bjh = scannedRef.map.get('百家号正常包A');
  assert.ok(official && bjh, '官网/百家号包已扫描');
  const beforeExcel = await fs.readFile(PLAN_HTTP_XLSX);
  const tasks = await call({ command: 'getTasks' });
  const officialTask = tasks.json.tasks.find((t) => t.packageId === official.packageId && t.platform === 'eyzao.com');
  const bjhTask = tasks.json.tasks.find((t) => t.packageId === bjh.packageId && t.platform === 'baijiahao');
  assert.ok(officialTask && bjhTask, '模拟任务已存在');

  const beforePublish = await call({ command: 'confirmExcelRegisteredSimulated', payload: { taskId: bjhTask.taskId, sheetName: '9月执行计划', rowIndex: '3' } });
  assert.equal(beforePublish.status, 422);
  assert.match(beforePublish.json.error, /尚未人工确认正式发布/);

  const registered = await call({
    command: 'confirmExcelRegisteredSimulated',
    payload: { taskId: officialTask.taskId, sheetName: '9月执行计划', rowIndex: '2', plTaskId: 'PL-2026-001', note: '登记预览一致' },
  });
  assert.equal(registered.status, 200, JSON.stringify(registered.json));
  assert.equal(registered.json.simulatedOnly, true);
  assert.equal(registered.json.task.publish.status, '人工确认已发布');
  assert.equal(registered.json.task.excel.status, '已登记');
  assert.equal(registered.json.task.archive.status, '未归档');
  assert.match(registered.json.notice, /未读取写回真实 Excel、未移动或归档/);

  const sneaky = await call({ command: 'confirmExcelRegisteredSimulated', payload: { taskId: officialTask.taskId, sheetName: '9月执行计划', path: 'C:\\real.xlsx' } });
  assert.equal(sneaky.status, 422);
  assert.deepEqual(await fs.readFile(PLAN_HTTP_XLSX), beforeExcel, '登记确认模拟不得改写 Excel');
});

test('2F HTTP：模拟人工确认归档，必须先发布并登记，不移动真实文件', async () => {
  const official = scannedRef.map.get('官网正常包A');
  const bjh = scannedRef.map.get('百家号正常包A');
  assert.ok(official && bjh, '官网/百家号包已扫描');
  const beforeExcel = await fs.readFile(PLAN_HTTP_XLSX);
  const archiveEntriesBefore = await fs.readdir(ARCHIVE);
  const tasks = await call({ command: 'getTasks' });
  const officialTask = tasks.json.tasks.find((t) => t.packageId === official.packageId && t.platform === 'eyzao.com');
  const bjhTask = tasks.json.tasks.find((t) => t.packageId === bjh.packageId && t.platform === 'baijiahao');
  assert.ok(officialTask && bjhTask, '模拟任务已存在');

  const beforePublish = await call({ command: 'confirmArchivedSimulated', payload: { taskId: bjhTask.taskId, targetPreview: path.join(ARCHIVE, bjh.relativePath) } });
  assert.equal(beforePublish.status, 422);
  assert.match(beforePublish.json.error, /尚未人工确认正式发布/);

  await call({ command: 'confirmPublishedSimulated', payload: { taskId: bjhTask.taskId, publicUrl: 'https://baijiahao.baidu.com/s?id=demo' } });
  const beforeRegister = await call({ command: 'confirmArchivedSimulated', payload: { taskId: bjhTask.taskId, targetPreview: path.join(ARCHIVE, bjh.relativePath) } });
  assert.equal(beforeRegister.status, 422);
  assert.match(beforeRegister.json.error, /尚未确认 Excel 已登记/);

  const archived = await call({
    command: 'confirmArchivedSimulated',
    payload: { taskId: officialTask.taskId, targetPreview: path.join(ARCHIVE, official.relativePath), note: '归档门槛预览通过' },
  });
  assert.equal(archived.status, 200, JSON.stringify(archived.json));
  assert.equal(archived.json.simulatedOnly, true);
  assert.equal(archived.json.task.publish.status, '人工确认已发布');
  assert.equal(archived.json.task.excel.status, '已登记');
  assert.equal(archived.json.task.archive.status, '已归档');
  assert.match(archived.json.notice, /未复制、未移动、未删除/);

  const remove = await call({ command: 'removeTask', payload: { taskId: officialTask.taskId } });
  assert.equal(remove.status, 422, '带归档状态的历史记录不得直接删除');
  const sneaky = await call({ command: 'confirmArchivedSimulated', payload: { taskId: officialTask.taskId, targetPreview: path.join(ARCHIVE, official.relativePath), path: 'C:\\real' } });
  assert.equal(sneaky.status, 422);
  assert.deepEqual(await fs.readFile(PLAN_HTTP_XLSX), beforeExcel, '归档确认模拟不得改写 Excel');
  assert.deepEqual(await fs.readdir(ARCHIVE), archiveEntriesBefore, '归档确认模拟不得移动/复制/删除真实归档目录内容');
});

test('1B HTTP：站点锁（仅限新服务进程协议内）——另一个模拟执行器持锁时停止，不创建任务', async () => {
  // 用一个尚未产生过任务的站点（eyzao.cn），否则会先命中任务键幂等（exists）而碰不到锁。
  const pkg = scannedRef.map.get('官网CN包H');
  assert.ok(pkg, 'eyzao.cn 夹具包已扫描到');
  const countBefore = (await call({ command: 'getTasks' })).json.count;
  // 让 mock 执行器占住 eyzao.cn 的站点锁
  const mock = spawn(process.execPath, [path.join(__dirname, 'fixtures', 'hold-site-lock.mjs')], {
    env: { ...process.env, YIZ_LOCK_DIR: LOCK_DIR, YIZ_SITE_KEY: 'eyzao.cn' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    let out = '';
    mock.stdout.on('data', (d) => { out += d; if (out.includes('READY')) resolve(); });
    mock.on('exit', () => reject(new Error('mock 执行器提前退出')));
    setTimeout(() => reject(new Error('mock 执行器启动超时')), 10000);
  });
  const r = await call({ command: 'simulateOfficialTask', payload: { packageId: pkg.packageId, siteKey: 'eyzao.cn' } });
  assert.equal(r.json.started, false, '站点锁被占时应停止');
  assert.equal(r.json.reason, 'site-lock-busy');
  assert.match(r.json.detail, /新服务进程|站点锁/);
  const tasks = await call({ command: 'getTasks' });
  assert.equal(tasks.json.count, countBefore, '锁占用时不得新增任何任务');
  // 结束 mock，等待锁真正释放后，同一个包/站点可以正常模拟（此前没有任何任务，所以是新建）。
  mock.kill();
  const probe = new CrossProcessLock(LOCK_DIR, siteLockKey('eyzao.cn'));
  const lockDeadline = Date.now() + 5000;
  while (Date.now() < lockDeadline) {
    if (await probe.acquire('test-probe')) { await probe.release(); break; }
    await new Promise((res) => setTimeout(res, 100));
  }
  const retry = await call({ command: 'simulateOfficialTask', payload: { packageId: pkg.packageId, siteKey: 'eyzao.cn' } });
  assert.equal(retry.json.started, true, `锁释放后应可继续：${JSON.stringify(retry.json)}`);
  assert.equal(retry.json.task.platform, 'eyzao.cn');
  // 幂等：同一个包/站点再模拟一次 → exists，绝不自动重发已核对过的内容
  const again = await call({ command: 'simulateOfficialTask', payload: { packageId: pkg.packageId, siteKey: 'eyzao.cn' } });
  assert.equal(again.json.started, false);
  assert.equal(again.json.reason, 'exists');
});

test('1B HTTP：removeTask 清理纯模拟任务后允许重新模拟', async () => {
  const tasks = await call({ command: 'getTasks' });
  assert.equal(tasks.json.count, 3, 'eyzao.com + baijiahao + eyzao.cn 三个模拟任务，其中 eyzao.com 已带人工确认发布状态不可直接删除');
  const first = tasks.json.tasks.find((t) => t.publish?.status === '未发布');
  assert.ok(first, '应存在未发布的纯模拟任务可清理');
  const rm = await call({ command: 'removeTask', payload: { taskId: first.taskId } });
  assert.equal(rm.status, 200, JSON.stringify(rm.json));
  assert.equal(rm.json.removed, true);
  const tasks2 = await call({ command: 'getTasks' });
  assert.equal(tasks2.json.count, 2);
});

test('Stage 3 HTTP：知乎草稿需确认、快照、顺序状态与回读证据，且不改变发布/Excel/归档状态', async () => {
  const pkg = scannedRef.map.get('知乎验收包I');
  assert.ok(pkg);
  const preflight = await call({ command: 'preflightPackage', payload: { packageId: pkg.packageId, platform: 'zhihu' } });
  assert.equal(preflight.status, 200, JSON.stringify(preflight.json));
  assert.equal(preflight.json.snapshot.siteKey, 'zhihu');
  assert.equal(preflight.json.snapshot.gate.executable, true);

  const denied = await call({ command: 'prepareZhihuDraft', payload: { packageId: pkg.packageId, userConfirmed: false } });
  assert.equal(denied.status, 422);
  const prepared = await call({ command: 'prepareZhihuDraft', payload: { packageId: pkg.packageId, userConfirmed: true } });
  assert.equal(prepared.status, 200, JSON.stringify(prepared.json));
  assert.equal(prepared.json.task.status, 'ready');
  const taskId = prepared.json.task.taskId;
  const snapshotId = prepared.json.task.snapshotId;
  const duplicate = await call({ command: 'prepareZhihuDraft', payload: { packageId: pkg.packageId, userConfirmed: true } });
  assert.equal(duplicate.json.started, false);
  assert.equal(duplicate.json.reason, 'exists');

  const begin = await call({ command: 'beginZhihuDraft', payload: { taskId, snapshotId, userConfirmed: true } });
  assert.equal(begin.json.task.status, 'running');
  for (const status of ['uploading', 'filling', 'saving_draft']) {
    const progress = await call({ command: 'advanceZhihuDraft', payload: { taskId, status } });
    assert.equal(progress.json.task.status, status);
  }
  const complete = await call({ command: 'completeZhihuDraft', payload: { taskId, result: {
    success: true, draftOnly: true, readBackVerified: true,
    postId: '12345', postUrl: 'https://zhuanlan.zhihu.com/p/12345/edit',
  } } });
  assert.equal(complete.json.task.status, 'waiting_confirmation');
  assert.equal(complete.json.task.publish.status, '未发布');
  assert.equal(complete.json.task.excel.status, '未登记');
  assert.equal(complete.json.task.archive.status, '未归档');
  const remove = await call({ command: 'removeTask', payload: { taskId } });
  assert.equal(remove.status, 422, '真实草稿任务审计记录不可删除');
});

test('1B HTTP：严格 schema——拒绝未知参数/非法 taskId/站点键，日志不含正文与令牌', async () => {
  const badSite = await call({ command: 'prepareOfficialTask', payload: { packageId: scannedRef.map.get('官网正常包A').packageId, siteKey: 'sohu' } });
  assert.equal(badSite.status, 422);
  assert.match(badSite.json.error, /siteKey/);
  const weird = await call({ command: 'simulateOfficialTask', payload: { packageId: scannedRef.map.get('官网正常包A').packageId, siteKey: 'eyzao.com', path: '/etc/passwd', command: 'bash', url: 'http://x' } });
  assert.equal(weird.status, 422);
  assert.match(weird.json.error, /未知参数/);
  const badTaskId = await call({ command: 'getTask', payload: { taskId: '../../../etc/passwd' } });
  assert.equal(badTaskId.status, 422);
  const unknownCmd = await call({ command: 'simulatePublish', payload: {} });
  assert.equal(unknownCmd.status, 400);
  // 未配对网页不能访问
  const web = await call({ command: 'getTasks' }, { origin: 'https://www.wechatsync.com' });
  assert.equal(web.status, 403);
});

test.after?.(() => { try { child?.kill?.(); } catch { /* 已退出 */ } });
