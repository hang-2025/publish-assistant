import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TaskStore, writeJsonAtomic } from '../lib/tasks.mjs';
import { TASK_STATUS } from '../domain/status.mjs';
import { checkRealActionGate } from '../lib/capabilities.mjs';
import { zhihuAdapter } from '../platforms/zhihu/index.mjs';
import { ZhihuDraftService } from '../services/zhihu-draft-service.mjs';
import { sohuAdapter } from '../platforms/sohu/index.mjs';
import { SohuDraftService } from '../services/sohu-draft-service.mjs';
import { toutiaoAdapter } from '../platforms/toutiao/index.mjs';
import { ToutiaoDraftService } from '../services/toutiao-draft-service.mjs';
import { neteaseAdapter } from '../platforms/netease/index.mjs';
import { NeteaseDraftService } from '../services/netease-draft-service.mjs';
import { xiaohongshuAdapter } from '../platforms/xiaohongshu/index.mjs';
import { XiaohongshuDraftService } from '../services/xiaohongshu-draft-service.mjs';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const serviceRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const startHereScript = path.join(serviceRoot, 'tools', 'acceptance', 'START-HERE.ps1');

function runPowerShell(args) {
  return new Promise(async (resolve, reject) => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yizao-stage3-launcher-'));
    const bomScript = path.join(tempDir, 'START-HERE.ps1');
    const source = await fs.readFile(startHereScript);
    await fs.writeFile(bomScript, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), source]));
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', bomScript, '-NoPause', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.on('error', reject);
    child.on('close', async (code) => {
      await fs.rm(tempDir, { recursive: true, force: true });
      resolve({ code, output });
    });
  });
}

function snapshot(version = 'a'.repeat(64)) {
  return {
    schema: 1, snapshotId: `snap-${version.slice(0, 24)}`, createdAt: '2026-09-07T00:00:00.000Z',
    source: { packageId: 'pkg-111111111111111111111111', rootName: 'unpublished', relativePath: '主流平台/知乎/测试', contentVersion: version },
    gate: { executable: true, blocks: [], warnings: [], readFailed: 0 },
    content: { title: '测试文章', imageCount: 1, byteCount: 3 },
    assets: [{ dir: '06-发布图片', name: '01.png', sha256: 'b'.repeat(64), bytes: 3 }],
    occurrences: [{ position: 1, assetName: '01.png', sha256: 'b'.repeat(64), effectiveAlt: '测试图', caption: '' }],
  };
}

function fidelityReport(overrides = {}) {
  const required = ['title', 'main-block-order', 'inline-emphasis', 'image-count', 'image-order', 'image-anchor', 'caption-equals-html-alt', 'trusted-draft-url', 'draft-only', 'read-back-verified'];
  return {
    schema: 'yizao-html-fidelity-report', version: 1, overall: 'PASS', fidelityVerified: true,
    summary: { pass: 12, degraded: 0, unsupported: 0, fail: 0 },
    checks: required.map((key) => ({ key, status: 'PASS', required: true, detail: '一致' })),
    ...overrides,
  };
}

test('Windows 任务 JSON 并发更新使用独立临时文件并保持完整', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yizao-atomic-task-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'task.json');
  await Promise.all(Array.from({ length: 20 }, (_, version) => writeJsonAtomic(file, { version, valid: true })));
  const saved = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(saved.valid, true);
  assert.equal(saved.version, 19);
  assert.deepEqual((await fs.readdir(dir)).filter((name) => name.endsWith('.tmp')), []);
});

async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yizao-stage3-'));
  const store = new TaskStore(path.join(dir, 'tasks'));
  let current = snapshot();
  const service = new ZhihuDraftService({
    store,
    loadSnapshot: async () => ({ snapshot: current, rootName: 'unpublished', relativePath: current.source.relativePath, segments: ['主流平台', '知乎', '测试'] }),
  });
  return { dir, store, service, change: () => { current = snapshot('c'.repeat(64)); } };
}

test('real action gate only permits explicitly confirmed Stage 3 Zhihu saveDraft', () => {
  const authorization = { stage: '3-zhihu-draft', userConfirmed: true, snapshotVerified: true };
  assert.equal(checkRealActionGate({ action: 'saveDraft', platform: 'zhihu', authorization }).allowed, true);
  for (const input of [
    { action: 'publish', platform: 'zhihu', authorization },
    { action: 'upload', platform: 'zhihu', authorization },
    { action: 'saveDraft', platform: 'sohu', authorization },
    { action: 'saveDraft', platform: 'zhihu' },
    { action: 'excelWrite', platform: 'zhihu', authorization },
    { action: 'archiveMove', platform: 'zhihu', authorization },
  ]) assert.equal(checkRealActionGate(input).allowed, false);
});
test('real action gate only permits explicitly confirmed Stage 4 Sohu saveDraft', () => {
  const authorization = { stage: '4-sohu-draft', userConfirmed: true, snapshotVerified: true };
  assert.equal(checkRealActionGate({ action: 'saveDraft', platform: 'sohu', authorization }).allowed, true);
  for (const input of [
    { action: 'publish', platform: 'sohu', authorization },
    { action: 'upload', platform: 'sohu', authorization },
    { action: 'saveDraft', platform: 'zhihu', authorization },
    { action: 'saveDraft', platform: 'sohu' },
    { action: 'excelWrite', platform: 'sohu', authorization },
    { action: 'archiveMove', platform: 'sohu', authorization },
  ]) assert.equal(checkRealActionGate(input).allowed, false);
});
test('real action gate only permits explicitly confirmed Stage 5 Toutiao saveDraft', () => {
  const authorization = { stage: '5-toutiao-draft', userConfirmed: true, snapshotVerified: true };
  assert.equal(checkRealActionGate({ action: 'saveDraft', platform: 'toutiao', authorization }).allowed, true);
  for (const input of [
    { action: 'publish', platform: 'toutiao', authorization },
    { action: 'upload', platform: 'toutiao', authorization },
    { action: 'saveDraft', platform: 'zhihu', authorization },
    { action: 'saveDraft', platform: 'sohu', authorization },
    { action: 'saveDraft', platform: 'toutiao' },
    { action: 'excelWrite', platform: 'toutiao', authorization },
    { action: 'archiveMove', platform: 'toutiao', authorization },
  ]) assert.equal(checkRealActionGate(input).allowed, false);
});
test('real action gate only permits explicitly confirmed Stage 6 NetEase saveDraft', () => {
  const authorization = { stage: '6-netease-draft', userConfirmed: true, snapshotVerified: true };
  assert.equal(checkRealActionGate({ action: 'saveDraft', platform: 'netease', authorization }).allowed, true);
  for (const input of [
    { action: 'publish', platform: 'netease', authorization },
    { action: 'upload', platform: 'netease', authorization },
    { action: 'saveDraft', platform: 'toutiao', authorization },
    { action: 'saveDraft', platform: 'netease' },
    { action: 'excelWrite', platform: 'netease', authorization },
    { action: 'archiveMove', platform: 'netease', authorization },
  ]) assert.equal(checkRealActionGate(input).allowed, false);
});
test('real action gate only permits explicitly confirmed Stage 7 Xiaohongshu saveDraft', () => {
  const authorization = { stage: '7-xiaohongshu-draft', userConfirmed: true, snapshotVerified: true };
  assert.equal(checkRealActionGate({ action: 'saveDraft', platform: 'xiaohongshu', authorization }).allowed, true);
  for (const input of [
    { action: 'publish', platform: 'xiaohongshu', authorization },
    { action: 'upload', platform: 'xiaohongshu', authorization },
    { action: 'saveDraft', platform: 'netease', authorization },
    { action: 'saveDraft', platform: 'xiaohongshu' },
    { action: 'excelWrite', platform: 'xiaohongshu', authorization },
    { action: 'archiveMove', platform: 'xiaohongshu', authorization },
  ]) assert.equal(checkRealActionGate(input).allowed, false);
});
test('Zhihu service adapter always rejects public publish', async () => {
  const result = await zhihuAdapter.publish();
  assert.equal(result.allowed, false);
  assert.equal(result.published, false);
});
test('Sohu service adapter exposes guarded draft workflow and rejects public publish', async () => {
  assert.equal(sohuAdapter.workflow, 'guarded-draft');
  assert.equal(sohuAdapter.capabilities.implementationAvailable, true);
  assert.equal(sohuAdapter.capabilities.verified, false);
  const result = await sohuAdapter.publish();
  assert.equal(result.allowed, false);
  assert.equal(result.published, false);
});
test('Toutiao service adapter exposes guarded draft workflow and rejects public publish', async () => {
  assert.equal(toutiaoAdapter.workflow, 'guarded-draft');
  assert.equal(toutiaoAdapter.capabilities.implementationAvailable, true);
  assert.equal(toutiaoAdapter.capabilities.verified, false);
  const result = await toutiaoAdapter.publish();
  assert.equal(result.allowed, false);
  assert.equal(result.published, false);
});
test('NetEase service adapter exposes guarded draft workflow and rejects public publish', async () => {
  assert.equal(neteaseAdapter.workflow, 'guarded-draft');
  assert.equal(neteaseAdapter.capabilities.implementationAvailable, true);
  assert.equal(neteaseAdapter.capabilities.verified, false);
  assert.equal(neteaseAdapter.capabilities.saveDraft, false);
  const result = await neteaseAdapter.publish();
  assert.equal(result.allowed, false);
  assert.equal(result.published, false);
});
test('Xiaohongshu service adapter exposes guarded draft workflow and rejects public publish', async () => {
  assert.equal(xiaohongshuAdapter.workflow, 'guarded-draft');
  assert.equal(xiaohongshuAdapter.capabilities.implementationAvailable, true);
  assert.equal(xiaohongshuAdapter.capabilities.verified, false);
  assert.equal(xiaohongshuAdapter.capabilities.saveDraft, false);
  const result = await xiaohongshuAdapter.publish();
  assert.equal(result.allowed, false);
  assert.equal(result.published, false);
});

async function xiaohongshuFixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yizao-stage7-xiaohongshu-'));
  const store = new TaskStore(path.join(dir, 'tasks'));
  let current = snapshot();
  current.source.relativePath = '主流平台/小红书/测试';
  const service = new XiaohongshuDraftService({
    store,
    loadSnapshot: async () => ({ snapshot: current, rootName: 'unpublished', relativePath: current.source.relativePath, segments: ['主流平台', '小红书', '测试'] }),
  });
  return { dir, store, service };
}

test('Xiaohongshu draft task requires confirmation and verified IndexedDB readback', async (t) => {
  const f = await xiaohongshuFixture(); t.after(() => fs.rm(f.dir, { recursive: true, force: true }));
  await assert.rejects(f.service.prepare({ packageId: snapshot().source.packageId, userConfirmed: false }), /明确确认/);
  const prepared = await f.service.prepare({ packageId: snapshot().source.packageId, userConfirmed: true });
  await f.service.begin({ taskId: prepared.task.taskId, snapshotId: prepared.task.snapshotId, userConfirmed: true });
  for (const status of [TASK_STATUS.UPLOADING, TASK_STATUS.FILLING, TASK_STATUS.SAVING_DRAFT]) await f.service.progress({ taskId: prepared.task.taskId, status });
  const checks = ['title', 'body-text', 'image-count', 'image-order', 'image-anchor', 'caption-equals-html-alt', 'draft-indexeddb', 'trusted-draft-url', 'draft-only', 'read-back-verified'];
  const report = { schema: 'yizao-html-fidelity-report', version: 1, overall: 'PASS', fidelityVerified: true,
    summary: { pass: 10, degraded: 0, unsupported: 0, fail: 0 },
    checks: checks.map((key) => ({ key, status: 'PASS', required: true, detail: '一致' })),
  };
  const done = await f.service.complete({ taskId: prepared.task.taskId, result: {
    success: true, draftOnly: true, readBackVerified: true, fidelityVerified: true, fidelityReport: report,
    postId: 's:local-draft-key', postUrl: 'https://creator.xiaohongshu.com/publish/publish?from=menu_left&target=article',
  } });
  assert.equal(done.status, TASK_STATUS.WAITING_CONFIRMATION);
  assert.equal(done.states.publish.status, '未发布');
});

test('Xiaohongshu draft task allows a confirmed retry when login failed before saving', async (t) => {
  const f = await xiaohongshuFixture(); t.after(() => fs.rm(f.dir, { recursive: true, force: true }));
  const first = await f.service.prepare({ packageId: snapshot().source.packageId, userConfirmed: true });
  await f.service.begin({ taskId: first.task.taskId, snapshotId: first.task.snapshotId, userConfirmed: true });
  await f.service.fail({ taskId: first.task.taskId, error: '登录检查未通过' });
  const retry = await f.service.prepare({ packageId: snapshot().source.packageId, userConfirmed: true });
  assert.equal(retry.started, true);
  assert.equal(retry.task.retryOfTaskId, first.task.taskId);
  assert.match(retry.task.taskKey, /:retry:2$/);
});

async function neteaseFixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yizao-stage6-netease-'));
  const store = new TaskStore(path.join(dir, 'tasks'));
  let current = snapshot();
  current.source.relativePath = '主流平台/网易/测试';
  const service = new NeteaseDraftService({
    store,
    loadSnapshot: async () => ({ snapshot: current, rootName: 'unpublished', relativePath: current.source.relativePath, segments: ['主流平台', '网易', '测试'] }),
  });
  return { dir, store, service, change: () => { current = snapshot('f'.repeat(64)); current.source.relativePath = '主流平台/网易/测试'; } };
}

test('NetEase draft task requires immutable snapshot, guardian check and verified readback', async (t) => {
  const f = await neteaseFixture(); t.after(() => fs.rm(f.dir, { recursive: true, force: true }));
  const prepared = await f.service.prepare({ packageId: snapshot().source.packageId, userConfirmed: true });
  assert.equal(prepared.task.status, TASK_STATUS.READY);
  await f.service.begin({ taskId: prepared.task.taskId, snapshotId: prepared.task.snapshotId, userConfirmed: true });
  for (const status of [TASK_STATUS.UPLOADING, TASK_STATUS.FILLING, TASK_STATUS.SAVING_DRAFT]) await f.service.progress({ taskId: prepared.task.taskId, status });
  const report = fidelityReport();
  report.checks.push({ key: 'guardian-token', status: 'PASS', required: true, detail: '官方风控通过' });
  report.summary.pass += 1;
  const done = await f.service.complete({ taskId: prepared.task.taskId, result: {
    success: true, draftOnly: true, readBackVerified: true, fidelityVerified: true, fidelityReport: report,
    postId: 'doc_13579', postUrl: 'https://mp.163.com/subscribe_v4/index.html#/article-publish/doc_13579',
  } });
  assert.equal(done.status, TASK_STATUS.WAITING_CONFIRMATION);
  assert.equal(done.draftResult.readBackVerified, true);
  assert.equal(done.states.publish.status, '未发布');
  assert.equal(done.states.excel.status, '未登记');
  assert.equal(done.states.archive.status, '未归档');
  const resave = await f.service.prepare({ packageId: snapshot().source.packageId, userConfirmed: true });
  assert.equal(resave.started, true, '草稿已保存后用户再次确认即允许重复保存');
  assert.equal(resave.task.retryOfTaskId, prepared.task.taskId);
  assert.match(resave.task.taskKey, /:retry:2$/);
});

test('NetEase draft task allows a confirmed retry when image upload failed before saving', async (t) => {
  const f = await neteaseFixture(); t.after(() => fs.rm(f.dir, { recursive: true, force: true }));
  const first = await f.service.prepare({ packageId: snapshot().source.packageId, userConfirmed: true });
  await f.service.begin({ taskId: first.task.taskId, snapshotId: first.task.snapshotId, userConfirmed: true });
  await f.service.progress({ taskId: first.task.taskId, status: TASK_STATUS.UPLOADING });
  await f.service.fail({ taskId: first.task.taskId, error: '图片上传在保存请求前失败' });
  const retry = await f.service.prepare({ packageId: snapshot().source.packageId, userConfirmed: true });
  assert.equal(retry.started, true);
  assert.equal(retry.task.retryOfTaskId, first.task.taskId);
  assert.match(retry.task.taskKey, /:retry:2$/);
});

test('NetEase draft task rejects untrusted URL and source mutation', async (t) => {
  const bad = await neteaseFixture(); t.after(() => fs.rm(bad.dir, { recursive: true, force: true }));
  const one = await bad.service.prepare({ packageId: snapshot().source.packageId, userConfirmed: true });
  await bad.service.begin({ taskId: one.task.taskId, snapshotId: one.task.snapshotId, userConfirmed: true });
  const report = fidelityReport();
  report.checks.push({ key: 'guardian-token', status: 'PASS', required: true, detail: '官方风控通过' });
  await assert.rejects(() => bad.service.complete({ taskId: one.task.taskId, result: {
    success: true, draftOnly: true, readBackVerified: true, fidelityVerified: true, fidelityReport: report,
    postId: 'doc_13579', postUrl: 'https://example.com/subscribe_v4/index.html#/article-publish/doc_13579',
  } }), /URL 不受信任/);

  const changed = await neteaseFixture(); t.after(() => fs.rm(changed.dir, { recursive: true, force: true }));
  const two = await changed.service.prepare({ packageId: snapshot().source.packageId, userConfirmed: true });
  changed.change();
  await assert.rejects(() => changed.service.begin({ taskId: two.task.taskId, snapshotId: two.task.snapshotId, userConfirmed: true }), /发生变化/);
  assert.equal((await changed.store.getTask(two.task.taskId)).status, TASK_STATUS.FAILED);
});

async function toutiaoFixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yizao-stage5-toutiao-'));
  const store = new TaskStore(path.join(dir, 'tasks'));
  let current = snapshot();
  current.source.relativePath = '主流平台/头条/测试';
  const service = new ToutiaoDraftService({
    store,
    loadSnapshot: async () => ({ snapshot: current, rootName: 'unpublished', relativePath: current.source.relativePath, segments: ['主流平台', '头条', '测试'] }),
  });
  return { dir, store, service, change: () => { current = snapshot('e'.repeat(64)); current.source.relativePath = '主流平台/头条/测试'; } };
}

test('Toutiao draft task requires immutable snapshot and verified readback', async (t) => {
  const f = await toutiaoFixture(); t.after(() => fs.rm(f.dir, { recursive: true, force: true }));
  const prepared = await f.service.prepare({ packageId: snapshot().source.packageId, userConfirmed: true });
  assert.equal(prepared.task.status, TASK_STATUS.READY);
  await f.service.begin({ taskId: prepared.task.taskId, snapshotId: prepared.task.snapshotId, userConfirmed: true });
  for (const status of [TASK_STATUS.UPLOADING, TASK_STATUS.FILLING, TASK_STATUS.SAVING_DRAFT]) {
    await f.service.progress({ taskId: prepared.task.taskId, status });
  }
  const done = await f.service.complete({ taskId: prepared.task.taskId, result: {
    success: true, draftOnly: true, readBackVerified: true, fidelityVerified: true, fidelityReport: fidelityReport(),
    postId: '13579', postUrl: 'https://mp.toutiao.com/profile_v4/graphic/publish?from=edit&pgc_id=13579',
  } });
  assert.equal(done.status, TASK_STATUS.WAITING_CONFIRMATION);
  assert.equal(done.draftResult.readBackVerified, true);
  assert.equal(done.states.publish.status, '未发布');
  assert.equal(done.states.excel.status, '未登记');
  assert.equal(done.states.archive.status, '未归档');
  const resave = await f.service.prepare({ packageId: snapshot().source.packageId, userConfirmed: true });
  assert.equal(resave.started, true, '草稿已保存后用户再次确认即允许重复保存');
  assert.equal(resave.task.retryOfTaskId, prepared.task.taskId);
  assert.match(resave.task.taskKey, /:retry:2$/);
});

test('Toutiao draft task rejects untrusted URL and source mutation', async (t) => {
  const bad = await toutiaoFixture(); t.after(() => fs.rm(bad.dir, { recursive: true, force: true }));
  const one = await bad.service.prepare({ packageId: snapshot().source.packageId, userConfirmed: true });
  await bad.service.begin({ taskId: one.task.taskId, snapshotId: one.task.snapshotId, userConfirmed: true });
  await assert.rejects(() => bad.service.complete({ taskId: one.task.taskId, result: {
    success: true, draftOnly: true, readBackVerified: true, fidelityVerified: true, fidelityReport: fidelityReport(),
    postId: '13579', postUrl: 'https://example.com/profile_v4/graphic/publish?from=edit&pgc_id=13579',
  } }), /URL 不受信任/);

  const changed = await toutiaoFixture(); t.after(() => fs.rm(changed.dir, { recursive: true, force: true }));
  const two = await changed.service.prepare({ packageId: snapshot().source.packageId, userConfirmed: true });
  changed.change();
  await assert.rejects(() => changed.service.begin({ taskId: two.task.taskId, snapshotId: two.task.snapshotId, userConfirmed: true }), /发生变化/);
  assert.equal((await changed.store.getTask(two.task.taskId)).status, TASK_STATUS.FAILED);
});

test('Toutiao draft task permits explicit re-saves while an in-flight task still blocks double clicks', async (t) => {
  const safe = await toutiaoFixture(); t.after(() => fs.rm(safe.dir, { recursive: true, force: true }));
  const first = await safe.service.prepare({ packageId: snapshot().source.packageId, userConfirmed: true });
  await safe.service.begin({ taskId: first.task.taskId, snapshotId: first.task.snapshotId, userConfirmed: true });
  await safe.service.progress({ taskId: first.task.taskId, status: TASK_STATUS.UPLOADING });
  await safe.service.fail({ taskId: first.task.taskId, error: '图片上传响应不兼容' });

  const retry = await safe.service.prepare({ packageId: snapshot().source.packageId, userConfirmed: true });
  assert.equal(retry.started, true);
  assert.notEqual(retry.task.taskId, first.task.taskId);
  assert.equal(retry.task.retryOfTaskId, first.task.taskId);
  assert.equal((await safe.store.getTask(first.task.taskId)).status, TASK_STATUS.FAILED, '旧失败记录必须保留');
  const duplicate = await safe.service.prepare({ packageId: snapshot().source.packageId, userConfirmed: true });
  assert.equal(duplicate.reason, 'exists', '新重试任务仍保持防双击幂等');

  const uncertain = await toutiaoFixture(); t.after(() => fs.rm(uncertain.dir, { recursive: true, force: true }));
  const saving = await uncertain.service.prepare({ packageId: snapshot().source.packageId, userConfirmed: true });
  await uncertain.service.begin({ taskId: saving.task.taskId, snapshotId: saving.task.snapshotId, userConfirmed: true });
  for (const status of [TASK_STATUS.UPLOADING, TASK_STATUS.FILLING, TASK_STATUS.SAVING_DRAFT]) {
    await uncertain.service.progress({ taskId: saving.task.taskId, status });
  }
  await uncertain.service.fail({ taskId: saving.task.taskId, error: '保存响应未知' });
  const confirmedRetry = await uncertain.service.prepare({ packageId: snapshot().source.packageId, userConfirmed: true });
  assert.equal(confirmedRetry.started, true, '终态失败后用户再次确认即允许重新保存');
  assert.equal(confirmedRetry.task.retryOfTaskId, saving.task.taskId);
});

async function sohuFixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yizao-stage4-sohu-'));
  const store = new TaskStore(path.join(dir, 'tasks'));
  let current = snapshot();
  current.source.relativePath = '主流平台/搜狐/测试';
  const service = new SohuDraftService({
    store,
    loadSnapshot: async () => ({ snapshot: current, rootName: 'unpublished', relativePath: current.source.relativePath, segments: ['主流平台', '搜狐', '测试'] }),
  });
  return { dir, store, service, change: () => { current = snapshot('d'.repeat(64)); current.source.relativePath = '主流平台/搜狐/测试'; } };
}

test('Sohu draft task requires immutable snapshot and verified readback', async (t) => {
  const f = await sohuFixture(); t.after(() => fs.rm(f.dir, { recursive: true, force: true }));
  const prepared = await f.service.prepare({ packageId: snapshot().source.packageId, userConfirmed: true });
  assert.equal(prepared.task.status, TASK_STATUS.READY);
  const duplicate = await f.service.prepare({ packageId: snapshot().source.packageId, userConfirmed: true });
  assert.equal(duplicate.reason, 'exists');
  await f.service.begin({ taskId: prepared.task.taskId, snapshotId: prepared.task.snapshotId, userConfirmed: true });
  await f.service.progress({ taskId: prepared.task.taskId, status: TASK_STATUS.UPLOADING });
  await f.service.progress({ taskId: prepared.task.taskId, status: TASK_STATUS.FILLING });
  await f.service.progress({ taskId: prepared.task.taskId, status: TASK_STATUS.SAVING_DRAFT });
  const done = await f.service.complete({ taskId: prepared.task.taskId, result: {
    success: true, draftOnly: true, readBackVerified: true, fidelityVerified: true, fidelityReport: fidelityReport(),
    postId: '24680', postUrl: 'https://mp.sohu.com/mpfe/v4/contentManagement/news/addarticle?spm=smmp.articlelist.0.0&contentStatus=2&id=24680',
  } });
  assert.equal(done.status, TASK_STATUS.WAITING_CONFIRMATION);
  assert.equal(done.draftResult.readBackVerified, true);
  assert.equal(done.states.publish.status, '未发布');
  assert.equal(done.states.excel.status, '未登记');
  assert.equal(done.states.archive.status, '未归档');
  const resave = await f.service.prepare({ packageId: snapshot().source.packageId, userConfirmed: true });
  assert.equal(resave.started, true, '草稿已保存后用户再次确认即允许重复保存');
  assert.equal(resave.task.retryOfTaskId, prepared.task.taskId);
  assert.match(resave.task.taskKey, /:retry:2$/);
});

test('Sohu draft task allows a confirmed retry when image upload failed before saving', async (t) => {
  const f = await sohuFixture(); t.after(() => fs.rm(f.dir, { recursive: true, force: true }));
  const first = await f.service.prepare({ packageId: snapshot().source.packageId, userConfirmed: true });
  await f.service.begin({ taskId: first.task.taskId, snapshotId: first.task.snapshotId, userConfirmed: true });
  await f.service.progress({ taskId: first.task.taskId, status: TASK_STATUS.UPLOADING });
  await f.service.fail({ taskId: first.task.taskId, error: '图片上传在保存请求前失败' });
  const retry = await f.service.prepare({ packageId: snapshot().source.packageId, userConfirmed: true });
  assert.equal(retry.started, true);
  assert.equal(retry.task.retryOfTaskId, first.task.taskId);
  assert.match(retry.task.taskKey, /:retry:2$/);
});

test('Sohu draft task rejects untrusted URL, incomplete fidelity and source mutation', async (t) => {
  const untrusted = await sohuFixture(); t.after(() => fs.rm(untrusted.dir, { recursive: true, force: true }));
  const one = await untrusted.service.prepare({ packageId: snapshot().source.packageId, userConfirmed: true });
  await untrusted.service.begin({ taskId: one.task.taskId, snapshotId: one.task.snapshotId, userConfirmed: true });
  await assert.rejects(() => untrusted.service.complete({ taskId: one.task.taskId, result: {
    success: true, draftOnly: true, readBackVerified: true, fidelityVerified: true, fidelityReport: fidelityReport(),
    postId: '24680', postUrl: 'https://example.com/?contentStatus=2&id=24680',
  } }), /URL 不受信任/);

  const incomplete = await sohuFixture(); t.after(() => fs.rm(incomplete.dir, { recursive: true, force: true }));
  const two = await incomplete.service.prepare({ packageId: snapshot().source.packageId, userConfirmed: true });
  await incomplete.service.begin({ taskId: two.task.taskId, snapshotId: two.task.snapshotId, userConfirmed: true });
  await assert.rejects(() => incomplete.service.complete({ taskId: two.task.taskId, result: {
    success: true, draftOnly: true, readBackVerified: true, fidelityVerified: true,
    fidelityReport: fidelityReport({ checks: [{ key: 'title', status: 'PASS', required: true, detail: '一致' }] }),
    postId: '24680', postUrl: 'https://mp.sohu.com/mpfe/v4/contentManagement/news/addarticle?contentStatus=2&id=24680',
  } }), /缺少必需 PASS/);

  const changed = await sohuFixture(); t.after(() => fs.rm(changed.dir, { recursive: true, force: true }));
  const three = await changed.service.prepare({ packageId: snapshot().source.packageId, userConfirmed: true });
  changed.change();
  await assert.rejects(() => changed.service.begin({ taskId: three.task.taskId, snapshotId: three.task.snapshotId, userConfirmed: true }), /发生变化/);
  assert.equal((await changed.store.getTask(three.task.taskId)).status, TASK_STATUS.FAILED);
});

test('Zhihu draft task follows durable happy path and blocks duplicate', async (t) => {
  const f = await fixture(); t.after(() => fs.rm(f.dir, { recursive: true, force: true }));
  const prepared = await f.service.prepare({ packageId: snapshot().source.packageId, userConfirmed: true });
  assert.equal(prepared.task.status, TASK_STATUS.READY);
  const duplicate = await f.service.prepare({ packageId: snapshot().source.packageId, userConfirmed: true });
  assert.equal(duplicate.reason, 'exists');
  await f.service.begin({ taskId: prepared.task.taskId, snapshotId: prepared.task.snapshotId, userConfirmed: true });
  await f.service.progress({ taskId: prepared.task.taskId, status: TASK_STATUS.UPLOADING });
  await f.service.progress({ taskId: prepared.task.taskId, status: TASK_STATUS.FILLING });
  await f.service.progress({ taskId: prepared.task.taskId, status: TASK_STATUS.SAVING_DRAFT });
  const done = await f.service.complete({ taskId: prepared.task.taskId, result: {
    success: true, draftOnly: true, readBackVerified: true, fidelityVerified: true, fidelityReport: fidelityReport(),
    postId: '12345', postUrl: 'https://zhuanlan.zhihu.com/p/12345/edit',
  } });
  assert.equal(done.status, TASK_STATUS.WAITING_CONFIRMATION);
  assert.equal(done.draftResult.readBackVerified, true);
  assert.equal(done.draftResult.fidelityVerified, true);
  assert.equal(done.states.publish.status, '未发布');
  assert.equal(done.states.excel.status, '未登记');
  assert.equal(done.states.archive.status, '未归档');
  const resave = await f.service.prepare({ packageId: snapshot().source.packageId, userConfirmed: true });
  assert.equal(resave.started, true, '草稿已保存后用户再次确认即允许重复保存');
  assert.equal(resave.task.retryOfTaskId, prepared.task.taskId);
  assert.match(resave.task.taskKey, /:retry:2$/);
  const whileInFlight = await f.service.prepare({ packageId: snapshot().source.packageId, userConfirmed: true });
  assert.equal(whileInFlight.reason, 'exists', '新任务执行中仍阻止连续双击');
});

test('Zhihu draft task allows a confirmed retry when image upload failed before saving', async (t) => {
  const f = await fixture(); t.after(() => fs.rm(f.dir, { recursive: true, force: true }));
  const first = await f.service.prepare({ packageId: snapshot().source.packageId, userConfirmed: true });
  await f.service.begin({ taskId: first.task.taskId, snapshotId: first.task.snapshotId, userConfirmed: true });
  await f.service.progress({ taskId: first.task.taskId, status: TASK_STATUS.UPLOADING });
  await f.service.fail({ taskId: first.task.taskId, error: '图片处理超时' });
  const retry = await f.service.prepare({ packageId: snapshot().source.packageId, userConfirmed: true });
  assert.equal(retry.started, true);
  assert.equal(retry.task.retryOfTaskId, first.task.taskId);
  assert.match(retry.task.taskKey, /:retry:2$/);
  const duplicate = await f.service.prepare({ packageId: snapshot().source.packageId, userConfirmed: true });
  assert.equal(duplicate.reason, 'exists', '新的重试任务仍应阻止连续双击');
});

test('draft saved without required fidelity cannot become draft_saved', async (t) => {
  const f = await fixture(); t.after(() => fs.rm(f.dir, { recursive: true, force: true }));
  const prepared = await f.service.prepare({ packageId: snapshot().source.packageId, userConfirmed: true });
  await f.service.begin({ taskId: prepared.task.taskId, snapshotId: prepared.task.snapshotId, userConfirmed: true });
  const failure = fidelityReport({ overall: 'FAIL', fidelityVerified: false, summary: { pass: 8, degraded: 0, unsupported: 0, fail: 1 } });
  failure.checks = failure.checks.map((check) => check.key === 'image-order' ? { ...check, status: 'FAIL', detail: '顺序不一致' } : check);
  await assert.rejects(() => f.service.complete({ taskId: prepared.task.taskId, result: {
    success: true, draftOnly: true, readBackVerified: true, fidelityVerified: false,
    fidelityReport: failure,
    postId: '12345', postUrl: 'https://zhuanlan.zhihu.com/p/12345/edit',
  } }), /内容保真/);
  assert.notEqual((await f.store.getTask(prepared.task.taskId)).status, TASK_STATUS.DRAFT_SAVED);
  const stopped = await f.service.fail({ taskId: prepared.task.taskId, error: '保真失败', fidelityReport: failure });
  assert.equal(stopped.status, TASK_STATUS.FAILED);
  assert.equal(stopped.fidelityFailure.overall, 'FAIL');
  assert.equal(stopped.fidelityFailure.checks.find((check) => check.key === 'image-order').status, 'FAIL');
});

test('fidelityVerified flag cannot replace the complete required check set', async (t) => {
  const f = await fixture(); t.after(() => fs.rm(f.dir, { recursive: true, force: true }));
  const prepared = await f.service.prepare({ packageId: snapshot().source.packageId, userConfirmed: true });
  await f.service.begin({ taskId: prepared.task.taskId, snapshotId: prepared.task.snapshotId, userConfirmed: true });
  await assert.rejects(() => f.service.complete({ taskId: prepared.task.taskId, result: {
    success: true, draftOnly: true, readBackVerified: true, fidelityVerified: true,
    fidelityReport: fidelityReport({ checks: [{ key: 'title', status: 'PASS', required: true, detail: '一致' }] }),
    postId: '12345', postUrl: 'https://zhuanlan.zhihu.com/p/12345/edit',
  } }), /缺少必需 PASS/);
});

test('source mutation and unverified save stop without draft_saved', async (t) => {
  const changed = await fixture(); t.after(() => fs.rm(changed.dir, { recursive: true, force: true }));
  const one = await changed.service.prepare({ packageId: snapshot().source.packageId, userConfirmed: true });
  changed.change();
  await assert.rejects(() => changed.service.begin({ taskId: one.task.taskId, snapshotId: one.task.snapshotId, userConfirmed: true }), /发生变化/);
  assert.equal((await changed.store.getTask(one.task.taskId)).status, TASK_STATUS.FAILED);

  const failed = await fixture(); t.after(() => fs.rm(failed.dir, { recursive: true, force: true }));
  const two = await failed.service.prepare({ packageId: snapshot().source.packageId, userConfirmed: true });
  await failed.service.begin({ taskId: two.task.taskId, snapshotId: two.task.snapshotId, userConfirmed: true });
  await failed.service.progress({ taskId: two.task.taskId, status: TASK_STATUS.UPLOADING });
  const stopped = await failed.service.fail({ taskId: two.task.taskId, error: '第 1 张图片上传失败' });
  assert.equal(stopped.status, TASK_STATUS.FAILED);
  assert.equal(stopped.draftResult, undefined);
});

test('restart recovery marks in-flight draft failed and never retries', async (t) => {
  const f = await fixture(); t.after(() => fs.rm(f.dir, { recursive: true, force: true }));
  const prepared = await f.service.prepare({ packageId: snapshot().source.packageId, userConfirmed: true });
  await f.service.begin({ taskId: prepared.task.taskId, snapshotId: prepared.task.snapshotId, userConfirmed: true });
  const restarted = new TaskStore(path.join(f.dir, 'tasks'));
  assert.equal(await restarted.recoverInterrupted(), 1);
  const task = await restarted.getTask(prepared.task.taskId);
  assert.equal(task.status, TASK_STATUS.FAILED);
  assert.equal(task.runState, 'stalled');
});

test('Windows acceptance launcher reports missing Node and occupied port without starting service', { skip: process.platform !== 'win32' }, async () => {
  const missing = await runPowerShell(['-NodeCommand', 'node-command-that-does-not-exist-for-stage3']);
  assert.equal(missing.code, 10);
  assert.match(missing.output, /Node\.js/);

  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  try {
    const occupied = await runPowerShell(['-NodeCommand', process.execPath, '-Port', String(port)]);
    assert.equal(occupied.code, 12);
    assert.match(occupied.output, new RegExp(String(port)));
  } finally {
    await new Promise((resolve) => listener.close(resolve));
  }
});

// ---------- CSDN 受保护草稿（与知乎同构的五阶段协调器） ----------
import { csdnAdapter } from '../platforms/csdn/index.mjs';
import { CsdnDraftService } from '../services/csdn-draft-service.mjs';

test('CSDN platform adapter exposes guarded draft workflow and rejects public publish', () => {
  assert.equal(csdnAdapter.workflow, 'guarded-draft');
  assert.equal(csdnAdapter.id, 'csdn');
});

test('real action gate permits explicitly confirmed CSDN saveDraft only', () => {
  const authorization = { stage: '3-csdn-draft', userConfirmed: true, snapshotVerified: true };
  assert.equal(checkRealActionGate({ action: 'saveDraft', platform: 'csdn', authorization }).allowed, true);
  assert.equal(checkRealActionGate({ action: 'publish', platform: 'csdn', authorization }).allowed, false);
  assert.equal(checkRealActionGate({ action: 'saveDraft', platform: 'csdn' }).allowed, false);
});

async function csdnFixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yizao-stage3-csdn-'));
  const store = new TaskStore(path.join(dir, 'tasks'));
  let current = snapshot();
  const service = new CsdnDraftService({
    store,
    loadSnapshot: async () => ({ snapshot: current, rootName: 'unpublished', relativePath: current.source.relativePath, segments: ['主流平台', 'CSDN', '测试'] }),
  });
  return { dir, store, service, change: () => { current = snapshot('e'.repeat(64)); } };
}

test('CSDN draft task follows durable happy path, allows re-save and blocks in-flight double click', async (t) => {
  const f = await csdnFixture(); t.after(() => fs.rm(f.dir, { recursive: true, force: true }));
  const prepared = await f.service.prepare({ packageId: snapshot().source.packageId, userConfirmed: true });
  assert.equal(prepared.task.status, TASK_STATUS.READY);
  const duplicate = await f.service.prepare({ packageId: snapshot().source.packageId, userConfirmed: true });
  assert.equal(duplicate.reason, 'exists');
  await f.service.begin({ taskId: prepared.task.taskId, snapshotId: prepared.task.snapshotId, userConfirmed: true });
  await f.service.progress({ taskId: prepared.task.taskId, status: TASK_STATUS.UPLOADING });
  await f.service.progress({ taskId: prepared.task.taskId, status: TASK_STATUS.FILLING });
  await f.service.progress({ taskId: prepared.task.taskId, status: TASK_STATUS.SAVING_DRAFT });
  const done = await f.service.complete({ taskId: prepared.task.taskId, result: {
    success: true, draftOnly: true, readBackVerified: true, fidelityVerified: true, fidelityReport: fidelityReport(),
    postId: '13579246', postUrl: 'https://editor.csdn.net/md?articleId=13579246',
  } });
  assert.equal(done.status, TASK_STATUS.WAITING_CONFIRMATION);
  assert.equal(done.draftResult.readBackVerified, true);
  assert.equal(done.states.publish.status, '未发布');
  assert.equal(done.states.excel.status, '未登记');
  assert.equal(done.states.archive.status, '未归档');
  const resave = await f.service.prepare({ packageId: snapshot().source.packageId, userConfirmed: true });
  assert.equal(resave.started, true, '草稿已保存后用户再次确认即允许重复保存');
  assert.equal(resave.task.retryOfTaskId, prepared.task.taskId);
  assert.match(resave.task.taskKey, /:retry:2$/);
});

test('CSDN draft task allows a confirmed retry when failure happened before saving', async (t) => {
  const f = await csdnFixture(); t.after(() => fs.rm(f.dir, { recursive: true, force: true }));
  const first = await f.service.prepare({ packageId: snapshot().source.packageId, userConfirmed: true });
  await f.service.begin({ taskId: first.task.taskId, snapshotId: first.task.snapshotId, userConfirmed: true });
  await f.service.progress({ taskId: first.task.taskId, status: TASK_STATUS.UPLOADING });
  await f.service.fail({ taskId: first.task.taskId, error: '图片上传失败' });
  const retry = await f.service.prepare({ packageId: snapshot().source.packageId, userConfirmed: true });
  assert.equal(retry.started, true);
  assert.equal(retry.task.retryOfTaskId, first.task.taskId);
  assert.match(retry.task.taskKey, /:retry:2$/);
  const duplicate = await f.service.prepare({ packageId: snapshot().source.packageId, userConfirmed: true });
  assert.equal(duplicate.reason, 'exists', '新任务执行中仍阻止连续双击');
});

test('CSDN draft task rejects untrusted URL, incomplete fidelity and source mutation', async (t) => {
  const bad = await csdnFixture(); t.after(() => fs.rm(bad.dir, { recursive: true, force: true }));
  const one = await bad.service.prepare({ packageId: snapshot().source.packageId, userConfirmed: true });
  await bad.service.begin({ taskId: one.task.taskId, snapshotId: one.task.snapshotId, userConfirmed: true });
  await assert.rejects(() => bad.service.complete({ taskId: one.task.taskId, result: {
    success: true, draftOnly: true, readBackVerified: true, fidelityVerified: true, fidelityReport: fidelityReport(),
    postId: '13579246', postUrl: 'https://example.com/md?articleId=13579246',
  } }), /URL 不受信任/);

  const changed = await csdnFixture(); t.after(() => fs.rm(changed.dir, { recursive: true, force: true }));
  const two = await changed.service.prepare({ packageId: snapshot().source.packageId, userConfirmed: true });
  changed.change();
  await assert.rejects(() => changed.service.begin({ taskId: two.task.taskId, snapshotId: two.task.snapshotId, userConfirmed: true }), /发生变化/);
  assert.equal((await changed.store.getTask(two.task.taskId)).status, TASK_STATUS.FAILED);
});

// ---------- 豆瓣受保护草稿（私密日记作为草稿形态） ----------
import { doubanAdapter } from '../platforms/douban/index.mjs';
import { DoubanDraftService } from '../services/douban-draft-service.mjs';

test('Douban platform adapter exposes guarded draft workflow and rejects public publish', () => {
  assert.equal(doubanAdapter.workflow, 'guarded-draft');
  assert.equal(doubanAdapter.id, 'douban');
});

test('real action gate permits explicitly confirmed Douban saveDraft only', () => {
  const authorization = { stage: '3-douban-draft', userConfirmed: true, snapshotVerified: true };
  assert.equal(checkRealActionGate({ action: 'saveDraft', platform: 'douban', authorization }).allowed, true);
  assert.equal(checkRealActionGate({ action: 'publish', platform: 'douban', authorization }).allowed, false);
  assert.equal(checkRealActionGate({ action: 'saveDraft', platform: 'douban' }).allowed, false);
});

async function doubanFixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yizao-stage3-douban-'));
  const store = new TaskStore(path.join(dir, 'tasks'));
  let current = snapshot();
  const service = new DoubanDraftService({
    store,
    loadSnapshot: async () => ({ snapshot: current, rootName: 'unpublished', relativePath: current.source.relativePath, segments: ['主流平台', '豆瓣', '测试'] }),
  });
  return { dir, store, service, change: () => { current = snapshot('f'.repeat(64)); } };
}

test('Douban draft task follows durable happy path, allows re-save and blocks in-flight double click', async (t) => {
  const f = await doubanFixture(); t.after(() => fs.rm(f.dir, { recursive: true, force: true }));
  const prepared = await f.service.prepare({ packageId: snapshot().source.packageId, userConfirmed: true });
  assert.equal(prepared.task.status, TASK_STATUS.READY);
  const duplicate = await f.service.prepare({ packageId: snapshot().source.packageId, userConfirmed: true });
  assert.equal(duplicate.reason, 'exists');
  await f.service.begin({ taskId: prepared.task.taskId, snapshotId: prepared.task.snapshotId, userConfirmed: true });
  await f.service.progress({ taskId: prepared.task.taskId, status: TASK_STATUS.UPLOADING });
  await f.service.progress({ taskId: prepared.task.taskId, status: TASK_STATUS.FILLING });
  await f.service.progress({ taskId: prepared.task.taskId, status: TASK_STATUS.SAVING_DRAFT });
  const done = await f.service.complete({ taskId: prepared.task.taskId, result: {
    success: true, draftOnly: true, readBackVerified: true, fidelityVerified: true, fidelityReport: fidelityReport(),
    postId: '1789436012', postUrl: 'https://www.douban.com/topic/create?draft_id=1789436012',
  } });
  assert.equal(done.status, TASK_STATUS.WAITING_CONFIRMATION);
  assert.equal(done.draftResult.readBackVerified, true);
  assert.equal(done.states.publish.status, '未发布');
  assert.equal(done.states.excel.status, '未登记');
  assert.equal(done.states.archive.status, '未归档');
  const resave = await f.service.prepare({ packageId: snapshot().source.packageId, userConfirmed: true });
  assert.equal(resave.started, true, '私密草稿保存后用户再次确认即允许重复保存');
  assert.match(resave.task.taskKey, /:retry:2$/);
});

test('Douban draft task allows a confirmed retry when failure happened before saving', async (t) => {
  const f = await doubanFixture(); t.after(() => fs.rm(f.dir, { recursive: true, force: true }));
  const first = await f.service.prepare({ packageId: snapshot().source.packageId, userConfirmed: true });
  await f.service.begin({ taskId: first.task.taskId, snapshotId: first.task.snapshotId, userConfirmed: true });
  await f.service.progress({ taskId: first.task.taskId, status: TASK_STATUS.UPLOADING });
  await f.service.fail({ taskId: first.task.taskId, error: '图片上传失败' });
  const retry = await f.service.prepare({ packageId: snapshot().source.packageId, userConfirmed: true });
  assert.equal(retry.started, true);
  assert.equal(retry.task.retryOfTaskId, first.task.taskId);
  const duplicate = await f.service.prepare({ packageId: snapshot().source.packageId, userConfirmed: true });
  assert.equal(duplicate.reason, 'exists', '新任务执行中仍阻止连续双击');
});

test('Douban draft task rejects untrusted URL and source mutation', async (t) => {
  const bad = await doubanFixture(); t.after(() => fs.rm(bad.dir, { recursive: true, force: true }));
  const one = await bad.service.prepare({ packageId: snapshot().source.packageId, userConfirmed: true });
  await bad.service.begin({ taskId: one.task.taskId, snapshotId: one.task.snapshotId, userConfirmed: true });
  await assert.rejects(() => bad.service.complete({ taskId: one.task.taskId, result: {
    success: true, draftOnly: true, readBackVerified: true, fidelityVerified: true, fidelityReport: fidelityReport(),
    postId: '1789436012', postUrl: 'https://example.com/note/1789436012/',
  } }), /URL 不受信任/);

  const changed = await doubanFixture(); t.after(() => fs.rm(changed.dir, { recursive: true, force: true }));
  const two = await changed.service.prepare({ packageId: snapshot().source.packageId, userConfirmed: true });
  changed.change();
  await assert.rejects(() => changed.service.begin({ taskId: two.task.taskId, snapshotId: two.task.snapshotId, userConfirmed: true }), /发生变化/);
  assert.equal((await changed.store.getTask(two.task.taskId)).status, TASK_STATUS.FAILED);
});

// ---------- 抖音受保护文章草稿 ----------
import { douyinAdapter } from '../platforms/douyin/index.mjs';
import { DouyinDraftService } from '../services/douyin-draft-service.mjs';

test('Douyin platform adapter exposes guarded draft workflow and rejects public publish', () => {
  assert.equal(douyinAdapter.workflow, 'guarded-draft');
  assert.equal(douyinAdapter.id, 'douyin');
});

test('real action gate permits explicitly confirmed Douyin saveDraft only', () => {
  const authorization = { stage: '3-douyin-draft', userConfirmed: true, snapshotVerified: true };
  assert.equal(checkRealActionGate({ action: 'saveDraft', platform: 'douyin', authorization }).allowed, true);
  assert.equal(checkRealActionGate({ action: 'publish', platform: 'douyin', authorization }).allowed, false);
  assert.equal(checkRealActionGate({ action: 'saveDraft', platform: 'douyin' }).allowed, false);
});

async function douyinFixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yizao-stage3-douyin-'));
  const store = new TaskStore(path.join(dir, 'tasks'));
  let current = snapshot();
  const service = new DouyinDraftService({
    store,
    loadSnapshot: async () => ({ snapshot: current, rootName: 'unpublished', relativePath: current.source.relativePath, segments: ['主流平台', '抖音', '测试'] }),
  });
  return { dir, store, service, change: () => { current = snapshot('a'.repeat(63) + 'b'); } };
}

test('Douyin draft task follows durable happy path and blocks in-flight double click', async (t) => {
  const f = await douyinFixture(); t.after(() => fs.rm(f.dir, { recursive: true, force: true }));
  const prepared = await f.service.prepare({ packageId: snapshot().source.packageId, userConfirmed: true });
  assert.equal(prepared.task.status, TASK_STATUS.READY);
  const duplicate = await f.service.prepare({ packageId: snapshot().source.packageId, userConfirmed: true });
  assert.equal(duplicate.reason, 'exists');
  await f.service.begin({ taskId: prepared.task.taskId, snapshotId: prepared.task.snapshotId, userConfirmed: true });
  await f.service.progress({ taskId: prepared.task.taskId, status: TASK_STATUS.UPLOADING });
  await f.service.fail({ taskId: prepared.task.taskId, error: '侦察阶段结束' });
  const retry = await f.service.prepare({ packageId: snapshot().source.packageId, userConfirmed: true });
  assert.equal(retry.started, true, '失败终态后允许重试');
});

test('Douyin draft completion accepts only a verified creator-center article draft', async (t) => {
  const f = await douyinFixture(); t.after(() => fs.rm(f.dir, { recursive: true, force: true }));
  const prepared = await f.service.prepare({ packageId: snapshot().source.packageId, userConfirmed: true });
  await f.service.begin({ taskId: prepared.task.taskId, snapshotId: prepared.task.snapshotId, userConfirmed: true });
  await f.service.progress({ taskId: prepared.task.taskId, status: TASK_STATUS.UPLOADING });
  await f.service.progress({ taskId: prepared.task.taskId, status: TASK_STATUS.FILLING });
  await f.service.progress({ taskId: prepared.task.taskId, status: TASK_STATUS.SAVING_DRAFT });
  const keys = [
    'title', 'main-block-order', 'inline-emphasis', 'image-count', 'image-order', 'image-anchor',
    'caption-equals-html-alt', 'trusted-draft-url', 'draft-only', 'read-back-verified',
  ];
  const checks = keys.map((key) => ({ key, status: 'PASS', required: true, detail: 'test' }));
  const result = {
    success: true, draftOnly: true, readBackVerified: true, fidelityVerified: true,
    postId: '541636',
    postUrl: 'https://creator.douyin.com/creator-micro/content/upload?page=article&draft_id=541636',
    fidelityReport: {
      schema: 'yizao-html-fidelity-report', version: 1, overall: 'PASS', fidelityVerified: true,
      summary: { pass: checks.length, degraded: 0, unsupported: 0, fail: 0 }, checks,
    },
  };
  const completed = await f.service.complete({ taskId: prepared.task.taskId, result });
  assert.equal(completed.status, TASK_STATUS.WAITING_CONFIRMATION);
  assert.equal(completed.draftResult.postId, '541636');

  const retry = await f.service.prepare({ packageId: snapshot().source.packageId, userConfirmed: true });
  await f.service.begin({ taskId: retry.task.taskId, snapshotId: retry.task.snapshotId, userConfirmed: true });
  await f.service.progress({ taskId: retry.task.taskId, status: TASK_STATUS.UPLOADING });
  await f.service.progress({ taskId: retry.task.taskId, status: TASK_STATUS.FILLING });
  await f.service.progress({ taskId: retry.task.taskId, status: TASK_STATUS.SAVING_DRAFT });
  await assert.rejects(() => f.service.complete({
    taskId: retry.task.taskId,
    result: { ...result, postUrl: 'https://example.com/creator-micro/content/upload?draft_id=541636' },
  }), /URL 不受信任/);
});
