import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SERVICE_BASE = 'http://127.0.0.1:8788';
const HEALTH_URL = `${SERVICE_BASE}/api/health`;
const EXTENSION_ORIGIN_RE = /^chrome-extension:\/\/[a-p]{32}$/i;
const launcherDir = path.dirname(fileURLToPath(import.meta.url));
const serviceDir = path.resolve(launcherDir, '..');

export function parseTrustedExtensionOrigin(config) {
  const origin = config?.security?.trustedOrigin;
  return typeof origin === 'string' && EXTENSION_ORIGIN_RE.test(origin) ? origin : null;
}

export function workbenchUrlForOrigin(origin) {
  if (!EXTENSION_ORIGIN_RE.test(String(origin || ''))) return null;
  return `${origin}/src/workbench/index.html`;
}

export function healthMatchesExpectedService(health) {
  return health?.ok === true && health?.name === 'yizao-sync-service';
}

async function readHealth() {
  try {
    const response = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

async function waitForService() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const health = await readHealth();
    if (healthMatchesExpectedService(health)) return health;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return null;
}

function startService() {
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: serviceDir,
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
  });
  child.unref();
}

function chromeCandidates() {
  const candidates = [];
  const localAppData = process.env.LOCALAPPDATA;
  const programFiles = process.env.ProgramFiles;
  const programFilesX86 = process.env['ProgramFiles(x86)'];
  if (localAppData) candidates.push(path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  if (programFiles) candidates.push(path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  if (programFilesX86) candidates.push(path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  return candidates;
}

function openChrome(url) {
  const chromePath = chromeCandidates().find((candidate) => fs.existsSync(candidate));
  if (!chromePath) throw new Error('没有找到 Google Chrome，请先安装或手动打开 Chrome。');
  const child = spawn(chromePath, ['--new-window', url], {
    detached: true,
    windowsHide: false,
    stdio: 'ignore',
  });
  child.unref();
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function readToken() {
  try {
    const token = fs.readFileSync(path.join(serviceDir, 'data', 'token'), 'utf8').trim();
    return /^[0-9a-f]{64}$/i.test(token) ? token : null;
  } catch {
    return null;
  }
}

async function main() {
  let health = await readHealth();
  if (health && !healthMatchesExpectedService(health)) {
    throw new Error('端口 8788 已被其他程序占用，请先关闭该程序。');
  }
  if (!health) {
    console.log('正在启动易造发布助手本地服务……');
    startService();
    health = await waitForService();
  }
  if (!healthMatchesExpectedService(health)) {
    throw new Error('本地服务启动失败，请确认 Node.js 已安装且端口 8788 未被占用。');
  }

  const config = readJson(path.join(serviceDir, 'data', 'config.json'));
  const origin = parseTrustedExtensionOrigin(config);
  const workbenchUrl = workbenchUrlForOrigin(origin);
  if (workbenchUrl) {
    openChrome(workbenchUrl);
    console.log('本地服务已就绪，正在打开工作台。');
    return;
  }

  openChrome('chrome://extensions');
  const token = readToken();
  console.log('\n这是首次安装，只需配对一次。');
  console.log('1. 在 Chrome 中确认已加载“文章同步助手”。');
  console.log('2. 点击扩展图标进入工作台。');
  console.log('3. 把下面的令牌粘贴到“服务配对”并保存：\n');
  console.log(token ? `  ${token}\n` : '  未读取到令牌，请重新运行启动器。\n');
  console.log('以后直接双击启动器，会自动启动服务并打开工作台。');
  process.exitCode = 2;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((error) => {
    console.error(`\n启动失败：${error.message}`);
    process.exitCode = 1;
  });
}
