import crypto from 'node:crypto';

/**
 * 不可变发送快照（阶段1B）。
 *
 * 目标：把「正文出现位置 → 文件资产 → 清单 ALT → HTML ALT → 已有图注」链
 * 收敛为一个不可变的发送快照，作为官网/百家号与草稿平台的发送依据。
 * - 快照只含元数据：内容哈希、正文出现顺序、资产名 + SHA-256、ALT、可见图注与冲突状态；
 *   不写入正文副本（需要正文时按授权的相对路径回读源包，避免在 data/ 与日志中留存正文）。
 * - 生成快照绝不覆盖源文章。
 *
 * 可执行门槛（进入可执行状态前必须 blocks 为空）：
 *   缺图 / 同名无法唯一绑定 / ALT 清单与 HTML 冲突 / 图片读取失败 / 无可用正文 / 必填 ALT 为空。
 * 其余（乱序、重复内容、包内未被正文引用的图片、数量不一致）仅作为 warnings，不阻止预览。
 */
export function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/** 规范化正文为参与指纹的最小文本（去空白差异，不改变内容本身）。 */
export function canonicalBody(html) {
  return String(html || '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/** 计算内容版本：正文规范化文本 + 每个出现位置的资产/ALT/图注参与指纹。 */
export function computeContentVersion({ html, occurrences }) {
  const parts = [canonicalBody(html)];
  for (const occ of occurrences) {
    parts.push([
      occ.src || '',
      occ.assetName || '',
      occ.manifestAlt || '',
      occ.htmlAlt || '',
      occ.effectiveAlt || '',
      occ.caption || '',
    ].join(''));
  }
  return sha256Hex(parts.join(''));
}

/**
 * 构建发送快照。
 *
 * @param {object} input
 * @param {object} input.info        inspectPackage() 的结果（含 occurrences / images / issues / notes / html / title）
 * @param {Function} input.readAsset (asset:{dir,name}) => Promise<{sha256:string,bytes:number}>，读取失败应 reject
 * @param {object} input.source      { packageId, rootName, relativePath }
 * @param {boolean} [input.requireAltPerImage=true] 平台是否要求每张图有有效 ALT
 * @returns {Promise<object>} 快照对象
 */
export async function buildSendSnapshot({ info, readAsset, source, requireAltPerImage = true }) {
  const warnings = [];
  const blocks = [];
  const html = info.html || '';
  const occurrences = info.occurrences || [];

  if (!html || !/<\s*(p|div|img|h[1-6]|table|figure|section|article)\b/i.test(html)) {
    blocks.push('没有可发送的正文 HTML：官网/百家号流程需要一个 HTML 正文');
  }

  // 图片读取（按正文出现位置），复用调用方注入的只读读取器。
  // 结果按出现位置记录；同一资产可出现在多处（同一文件只统计一次字节/hash）。
  const seen = new Map(); // assetKey(dir/name) -> index in assets
  const assets = [];
  const occurrenceRows = [];
  let readFailed = 0;
  for (const occ of occurrences) {
    const row = {
      position: occ.position,
      src: occ.src || '',
      name: occ.name || '',
      assetName: occ.assetName || '',
      assetDir: occ.assetDir || '',
      assetMatch: occ.assetMatch || '',
      manifestAlt: occ.manifestAlt || '',
      htmlAlt: occ.htmlAlt || '',
      effectiveAlt: occ.effectiveAlt || '',
      altSource: occ.altSource || '',
      altConflict: !!occ.altConflict,
      caption: occ.caption || '',
      captionSource: occ.captionSource || '',
      sha256: '',
      readError: '',
    };
    const key = occ.assetDir && occ.assetName ? `${occ.assetDir}/${occ.assetName}` : '';
    if (key) {
      let assetIndex = seen.get(key);
      if (assetIndex === undefined) {
        const asset = { dir: occ.assetDir, name: occ.assetName, sha256: '', bytes: 0, readError: '' };
        try {
          const meta = await readAsset(asset);
          asset.sha256 = meta.sha256;
          asset.bytes = meta.bytes;
        } catch (err) {
          asset.readError = err.message;
          readFailed += 1;
          blocks.push(`图片读取失败：${key}（${err.message}）`);
        }
        assetIndex = assets.push(asset) - 1;
        seen.set(key, assetIndex);
      }
      const asset = assets[assetIndex];
      row.sha256 = asset.sha256;
      row.readError = asset.readError;
    } else {
      // 正文引用了图片但无法唯一映射到包内资产 → 阻止进入可执行状态。
      if (occ.assetMatch === '同名冲突') {
        blocks.push(`同名图片无法唯一绑定（正文第 ${occ.position} 张）：${occ.name}`);
      } else if (occ.assetMatch === '未找到文件') {
        blocks.push(`正文引用的图片在包内未找到（缺图，正文第 ${occ.position} 张）：${occ.name}`);
      } else {
        blocks.push(`正文图片未能关联到包内资产（正文第 ${occ.position} 张）：${occ.name}`);
      }
    }
    if (row.altConflict) blocks.push(`ALT 冲突：正文第 ${occ.position} 张（${occ.name}）清单与 HTML 不一致`);
    if (!row.effectiveAlt && requireAltPerImage) {
      blocks.push(`缺少 ALT：正文第 ${occ.position} 张（${occ.name}）没有清单或 HTML ALT`);
    }
    occurrenceRows.push(row);
  }

  for (const issue of info.issues || []) {
    if (/缺图|同名|ALT 冲突|不连续|为空|数量不一致/.test(issue)) {
      warnings.push(issue); // 具体阻塞已按行处理；这里保留原始提示供界面展示
    } else {
      warnings.push(issue);
    }
  }
  for (const note of info.notes || []) warnings.push(note);

  const contentVersion = computeContentVersion({ html, occurrences: occurrenceRows });

  // 资产去重后的最终发送清单（按首次出现顺序）。缺图/读取失败的资产不进入可执行快照。
  const executable = blocks.length === 0;
  const sendAssets = assets
    .filter((a) => !a.readError)
    .map((a) => ({ dir: a.dir, name: a.name, sha256: a.sha256, bytes: a.bytes }));
  const seoCategory = String((info.seo && (info.seo['内容栏目'] || info.seo['栏目'])) || '').trim();

  return {
    schema: 1,
    snapshotId: `snap-${sha256Hex(JSON.stringify({
      contentVersion,
      assets: sendAssets.map((a) => `${a.dir}/${a.name}:${a.sha256}`),
    })).slice(0, 24)}`,
    createdAt: new Date().toISOString(),
    source: {
      packageId: source.packageId,
      rootName: source.rootName,
      relativePath: source.relativePath,
      contentVersion,
    },
    gate: { executable, blocks, warnings, readFailed },
    // 可见图注策略：ALT 与图注永远是两个字段；官网/百家号默认不追加可见图注，这里只回显正文已有图注。
    content: {
      title: info.title || '',
      imageCount: sendAssets.length,
      byteCount: sendAssets.reduce((sum, a) => sum + a.bytes, 0),
      seoCategory,
    },
    assets: sendAssets,
    occurrences: occurrenceRows,
  };
}

/** 稳定任务键：packageId + platform + accountId + contentVersion。 */
export function makeTaskKey({ packageId, platform, accountId, contentVersion }) {
  return `${packageId}|${platform}|${accountId}|${contentVersion}`;
}
