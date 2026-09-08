import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TaskStore } from '../lib/tasks.mjs';
import { TASK_STATUS } from '../domain/status.mjs';
import { checkRealActionGate } from '../lib/capabilities.mjs';
import { zhihuAdapter } from '../platforms/zhihu/index.mjs';
import { ZhihuDraftService } from '../services/zhihu-draft-service.mjs';
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
test('Zhihu service adapter always rejects public publish', async () => {
  const result = await zhihuAdapter.publish();
  assert.equal(result.allowed, false);
  assert.equal(result.published, false);
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
    success: true, draftOnly: true, readBackVerified: true, postId: '12345', postUrl: 'https://zhuanlan.zhihu.com/p/12345/edit',
  } });
  assert.equal(done.status, TASK_STATUS.WAITING_CONFIRMATION);
  assert.equal(done.draftResult.readBackVerified, true);
  assert.equal(done.states.publish.status, '未发布');
  assert.equal(done.states.excel.status, '未登记');
  assert.equal(done.states.archive.status, '未归档');
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
