import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

/**
 * 跨进程互斥方案（阶段1A：仅设计与实现锁机制，本轮不启动任何执行器）。
 *
 * 目的：禁止新工作台与原「自动化发布」助手同时占用同一浏览器资料目录
 * （Playwright 的 Chromium 自身会对 profile 目录加 singleton 锁，但两个
 *  Node 进程在“谁拥有任务”层面仍会双写）。
 *
 * 方案：
 * - 锁文件 data/executor.lock，内容为 JSON：{ pid, since, owner }；
 * - acquire 用 O_CREAT|O_EXCL 原子创建；已存在时读取 pid，
 *   用 process.kill(pid, 0) 探测存活：存活则拒绝，死亡则接管（先删后建，仍原子）；
 * - release 只删除“自己创建”的锁（比对 pid），不误删他人锁；
 * - 后续阶段接入官网/百家号执行器时，执行器进程必须先 acquire(profileKey)
 *   才能启动 Playwright；原助手不加锁，因此新执行器启动前还需人工确认原助手已退出
 *   （PRD 阶段2 会给出与原助手站点锁合并的具体方案）。
 */

export class CrossProcessLock {
  constructor(lockDir, key) {
    this.lockPath = path.join(lockDir, `executor-${String(key).replace(/[^a-zA-Z0-9_-]/g, '_')}.lock`);
    this.acquired = false;
  }

  async acquire(owner = 'unknown') {
    const payload = JSON.stringify({ pid: process.pid, since: new Date().toISOString(), owner });
    try {
      fs.writeFileSync(this.lockPath, payload, { flag: 'wx' });
      this.acquired = true;
      return true;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    // 锁已存在：检查持有者是否存活
    let holder = null;
    try { holder = JSON.parse(await fsp.readFile(this.lockPath, 'utf8')); } catch { /* 损坏的锁视为死亡 */ }
    if (holder && Number.isInteger(holder.pid)) {
      try { process.kill(holder.pid, 0); return false; } catch { /* 进程已退出 */ }
    }
    await fsp.rm(this.lockPath, { force: true });
    try {
      fs.writeFileSync(this.lockPath, payload, { flag: 'wx' });
      this.acquired = true;
      return true;
    } catch {
      return false; // 并发竞争失败
    }
  }

  async release() {
    if (!this.acquired) return;
    let holder = null;
    try { holder = JSON.parse(await fsp.readFile(this.lockPath, 'utf8')); } catch { /* 锁文件已消失 */ }
    if (holder?.pid === process.pid) await fsp.rm(this.lockPath, { force: true });
    this.acquired = false;
  }
}
