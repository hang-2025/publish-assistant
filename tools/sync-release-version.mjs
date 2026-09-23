import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'release-manifest.json'), 'utf8'));
const checkOnly = process.argv.includes('--check');

function assertString(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} 必须是非空字符串`);
}

assertString(manifest.productName, 'productName');
assertString(manifest.releaseVersion, 'releaseVersion');
assertString(manifest.channel, 'channel');
assertString(manifest.buildId, 'buildId');
assertString(manifest.components?.extensionVersion, 'components.extensionVersion');
assertString(manifest.components?.serviceVersion, 'components.serviceVersion');
assertString(manifest.protocol?.name, 'protocol.name');
if (!Number.isSafeInteger(manifest.packageVersion) || manifest.packageVersion < 1) throw new Error('packageVersion 必须是正整数');
if (!Number.isSafeInteger(manifest.protocol?.version) || manifest.protocol.version < 1) throw new Error('protocol.version 必须是正整数');
if (!/^(alpha|beta|rc|stable)$/.test(manifest.channel)) throw new Error('channel 只能是 alpha、beta、rc 或 stable');
if (!/^\d+\.\d+\.\d+(?:-(?:alpha|beta|rc)\.\d+)?$/.test(manifest.releaseVersion)) throw new Error('releaseVersion 不符合发布版本格式');
if (!/^\d+(?:\.\d+){0,3}$/.test(manifest.components.extensionVersion)) throw new Error('Chrome 扩展版本必须是 1 至 4 段数字');

const info = {
  productName: manifest.productName,
  releaseVersion: manifest.releaseVersion,
  channel: manifest.channel,
  buildId: manifest.buildId,
  packageVersion: manifest.packageVersion,
  extensionVersion: manifest.components.extensionVersion,
  serviceVersion: manifest.components.serviceVersion,
  protocol: manifest.protocol,
};
const extensionGenerated = `// 此文件由 tools/sync-release-version.mjs 根据 release-manifest.json 生成，请勿手改。\nexport const RELEASE_INFO = ${JSON.stringify(info, null, 2)} as const\n`;
const serviceGenerated = `// 此文件由 tools/sync-release-version.mjs 根据 release-manifest.json 生成，请勿手改。\nexport const RELEASE_INFO = Object.freeze(${JSON.stringify(info, null, 2)});\n`;

const targets = [
  [path.join(root, 'wechatsync-source', 'Wechatsync-2', 'packages', 'extension', 'src', 'release-info.generated.ts'), extensionGenerated],
  [path.join(root, 'yizao-sync-service', 'lib', 'release-info.generated.mjs'), serviceGenerated],
];
const packageChecks = [
  [path.join(root, 'wechatsync-source', 'Wechatsync-2', 'packages', 'extension', 'package.json'), manifest.components.extensionVersion],
  [path.join(root, 'wechatsync-source', 'Wechatsync-2', 'packages', 'extension', 'manifest.json'), manifest.components.extensionVersion],
  [path.join(root, 'yizao-sync-service', 'package.json'), manifest.components.serviceVersion],
];

for (const [file, expectedVersion] of packageChecks) {
  const actual = JSON.parse(fs.readFileSync(file, 'utf8')).version;
  if (actual !== expectedVersion) throw new Error(`${path.relative(root, file)} 版本为 ${actual}，发布清单要求 ${expectedVersion}`);
}

let changed = false;
for (const [file, expected] of targets) {
  const actual = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n') : '';
  if (actual === expected) continue;
  changed = true;
  if (checkOnly) throw new Error(`${path.relative(root, file)} 未与 release-manifest.json 同步，请运行 node tools/sync-release-version.mjs`);
  fs.writeFileSync(file, expected, 'utf8');
  console.log(`已更新 ${path.relative(root, file)}`);
}

console.log(changed ? '发布版本文件已同步。' : '发布版本文件已是最新。');
