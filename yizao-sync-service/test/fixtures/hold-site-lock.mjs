// 测试夹具：模拟「另一个遵循同一文件锁协议的新服务模拟执行器」占住指定站点锁。
// 作用域（审查返工 P0-2）：它只能证明新服务的新模拟执行器进程之间互斥；
// 旧助手并未接入本协议，所以这里**不代表**与旧执行器互斥。
// 仅用于 1B 测试的临时锁目录；不启动任何真实执行器、不占用任何 Chrome 登录资料。
import path from 'node:path';
import { CrossProcessLock } from '../../lib/mutex.mjs';
import { siteLockKey } from '../../lib/official-flow.mjs';

const lockDir = path.resolve(process.env.YIZ_LOCK_DIR || '');
const siteKey = process.env.YIZ_SITE_KEY || 'eyzao.com';
if (!lockDir) { console.error('需要 YIZ_LOCK_DIR'); process.exit(2); }

const lock = new CrossProcessLock(lockDir, siteLockKey(siteKey));
const ok = await lock.acquire(`mock-executor-${process.pid}`);
if (!ok) { console.error('mock 执行器未能拿到锁（可能已被占用）'); process.exit(3); }
console.log('READY');
// 保持存活直到被测试方结束。测试会用 child.kill() 结束本进程；若系统未投递信号，
// 锁文件会带着已死亡的 pid 留下，随后由接管逻辑清除——这正是要验证的语义之一。
const hold = setInterval(() => {}, 1000);
const releaseExit = async () => { clearInterval(hold); await lock.release().catch(() => {}); process.exit(0); };
process.on('SIGTERM', releaseExit);
process.on('SIGINT', releaseExit);
