import { findHeaderRow } from './xlsx.mjs';

/**
 * Excel 只读映射原型（阶段1B，2026-09-04 审查返工收紧）。
 *
 * 只能用于「新建的模拟 .xlsx 夹具」；本模块不读写真实表格。
 * 提供：
 * - 工作表/列映射预览：识别计划表头（任务编号/平台/分类…），给出字段→列建议；
 *   出现多候选表头/一列多义/多个表头行时**返回冲突并要求人工确认，绝不自动猜列**；
 * - 行定位：优先按「PL-* 任务编号 + 平台」唯一匹配；0 行 → 拟追加行预览；
 *   多行 → 立即停止（绝不猜测）；缺任务编号/格式非法 → 「需要绑定」；
 *   平台列为空的行**不得**被静默当成命中，必须返回「需要人工绑定/确认」；
 * - 本阶段没有 commit/write；返回值都是只读预览。
 *
 * 关于写入能力：仓库里的 `writeXlsx()` 只服务于“生成测试夹具”，
 * 不能把它描述成生产写入能力；运行时/命令层不暴露任何 Excel 写入。
 */

const ROLE_KEYWORDS = {
  taskId: ['任务编号', '任务号', 'pl编号', '计划编号'],
  platform: ['平台', '站点', '网站'],
  category: ['产品分类', '分类', '栏目', '产品'],
  title: ['文章标题', '标题'],
  date: ['计划日期', '日期', '发布日期'],
  status: ['发布状态', '状态', '登记状态'],
  link: ['正式链接', '链接', 'url'],
  source: ['来源包', '包标识', '来源'],
};

/** 定位一行所必需的字段：这两个角色的列映射有冲突就必须停下来问人。 */
const REQUIRED_ROLES = ['taskId', 'platform'];

const HEADER_HINT = ['任务编号', '任务号', 'pl编号', '平台', '编号'];

/** 计划任务编号的正式格式：PL-<4位年份>-<1~4位序号>，允许 -A1 这类可选后缀。 */
export const PL_TASK_ID_RE = /^PL-\d{4}-\d{1,4}(?:-[A-Za-z0-9]{1,4})?$/;
export const PL_FORMAT_HINT = 'PL-YYYY-N（例如 PL-2026-001；可选后缀形如 -A1）';

/**
 * 任务编号分类（审查返工 P1-1.1：PL- 空编号不得视为合法任务编号）。
 * @returns {{code:'ok'|'missing-task-id'|'empty-pl-number'|'invalid-task-id', value:string, normalized:string}}
 */
export function classifyTaskId(v) {
  const raw = String(v ?? '').trim();
  if (!raw) return { code: 'missing-task-id', value: '', normalized: '' };
  const s = raw.replace(/\s+/g, '').toUpperCase();
  if (/^PL-?$/.test(s)) return { code: 'empty-pl-number', value: raw, normalized: '' };
  if (!PL_TASK_ID_RE.test(s)) return { code: 'invalid-task-id', value: raw, normalized: '' };
  return { code: 'ok', value: raw, normalized: s };
}

/** 规范化任务编号：符合格式返回大写无空格形式，否则返回空串（绝不返回「PL-」这种空编号）。 */
export function normalizePl(v) {
  return classifyTaskId(v).normalized;
}

/**
 * 猜测每个登记字段对应的列（列映射预览，只在表头行内匹配，避免命中数据行）。
 * 审查返工 P1-1.3：多候选列 / 一列多义 / 多个表头行一律记为 conflicts，
 * 且**冲突字段不进入 mapping**，由调用方停下来要求人工确认。
 */
export function sniffColumnMapping(rows) {
  const header = findHeaderRow(rows, HEADER_HINT);
  const headerRowIndex = header.headerRow;
  const headerRow = headerRowIndex >= 0 ? (header.row || []) : [];
  const conflicts = [];
  const mapping = {};
  const matched = [];
  const unmatched = [];
  const candidates = new Map(); // role -> [{column, header}]
  const columnRoles = new Map(); // column -> [role]

  const hitsKeyword = (cell) => {
    const low = String(cell ?? '').trim().toLowerCase();
    if (!low) return false;
    return Object.values(ROLE_KEYWORDS).some((kws) => kws.some((k) => low.includes(k.toLowerCase())));
  };

  for (let c = 0; c < headerRow.length; c += 1) {
    const cell = String(headerRow[c] ?? '').trim();
    if (!cell) continue;
    const low = cell.toLowerCase();
    for (const [role, kws] of Object.entries(ROLE_KEYWORDS)) {
      if (!kws.some((k) => low.includes(k.toLowerCase()))) continue;
      if (!candidates.has(role)) candidates.set(role, []);
      candidates.get(role).push({ column: c, header: cell });
      if (!columnRoles.has(c)) columnRoles.set(c, []);
      // 同一列被同一角色的多个关键词命中只算一次，避免把「平台站点」误判成一列多义。
      if (!columnRoles.get(c).includes(role)) columnRoles.get(c).push(role);
    }
  }

  for (const [role, cols] of candidates) {
    if (cols.length > 1) {
      conflicts.push({ type: 'multiple-columns', role, columns: cols.map((x) => x.column), headers: cols.map((x) => x.header) });
    }
  }
  for (const [col, roles] of columnRoles) {
    if (roles.length > 1) {
      conflicts.push({ type: 'column-claims-multiple-roles', column: col, header: String(headerRow[col] ?? '').trim(), roles });
    }
  }
  // 多个候选表头行：表头行之后 5 行内若又出现一行「像表头且不像数据」的行，视为表头不确定。
  // 必须排除数据行：中文标题里常含「平台/标题」等词，只看关键词会把数据行误判成表头。
  const looksLikeData = (row) => (row || []).some((cell) => {
    const s = String(cell ?? '').trim();
    return /^PL-/i.test(s) || /^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/.test(s) || /^-?\d+(\.\d+)?$/.test(s);
  });
  if (headerRowIndex >= 0) {
    for (let r = headerRowIndex + 1; r < Math.min(rows.length, headerRowIndex + 6); r += 1) {
      if (looksLikeData(rows[r])) continue;
      const hits = (rows[r] || []).filter((cell) => hitsKeyword(cell)).length;
      if (hits >= 2) { conflicts.push({ type: 'multiple-header-rows', rows: [headerRowIndex, r] }); break; }
    }
  }

  for (const [role, cols] of candidates) {
    if (cols.length === 1 && (columnRoles.get(cols[0].column) || []).length === 1) mapping[role] = cols[0].column;
  }
  for (const role of Object.keys(ROLE_KEYWORDS)) {
    if (mapping[role] !== undefined) matched.push(role); else unmatched.push(role);
  }
  return { mapping, matched, unmatched, conflicts, headerRowIndex, headerRow, ok: conflicts.length === 0 };
}

/** 判断某一行是不是计划表数据行（跳过标题行与空行/合计）。 */
function isDataRow(rows, r, mapping) {
  const taskId = rows[r]?.[mapping.taskId]?.toString().trim() || '';
  const platform = rows[r]?.[mapping.platform]?.toString().trim() || '';
  if (taskId) return true;
  if (/合计|总计|小计/.test(String(rows[r]?.join?.(' ') || ''))) return false;
  // 无任务编号但有平台等字段也算数据行（用于按平台/分类定位）
  return Boolean(platform) || rows[r]?.some?.((cell) => String(cell).trim());
}

function cell(row, col) { return String(row?.[col] ?? '').trim(); }

/**
 * 解析平台计划表的分辨结果。
 * @param {object} args
 * @param {string[][]} args.rows        工作表全部行
 * @param {object} [args.colMap]        字段→列；缺省用 sniff
 * @param {object} [args.sniffed]       sniffColumnMapping 结果（用于把列冲突带进来）
 * @param {object} args.query           { plTaskId?, platform, category?, title?, date? }
 * @returns {object} resolution（kind + code + 说明；code 便于界面区分提示文案）
 */
export function resolvePlanRows({ rows, colMap, sniffed: sniffedIn, query }) {
  const sniffed = sniffedIn || (colMap ? null : sniffColumnMapping(rows));
  const mapping = colMap || (sniffed ? sniffed.mapping : {});
  const conflicts = sniffed ? sniffed.conflicts : [];
  const out = { colMap: mapping, kind: '', code: '', rows: [], matched: null, appendRow: null, notice: '', conflicts };

  // 0) 列映射只要影响「任务编号/平台」的定位，就不许猜，必须先人工确认。
  const blocking = conflicts.filter((cf) => cf.type === 'multiple-header-rows'
    || (cf.role && REQUIRED_ROLES.includes(cf.role))
    || (cf.roles && cf.roles.some((r) => REQUIRED_ROLES.includes(r))));
  if (blocking.length) {
    const desc = blocking.map((cf) => (cf.type === 'multiple-columns'
      ? `字段「${cf.role}」匹配到多列（${cf.headers.join(' / ')}）`
      : cf.type === 'column-claims-multiple-roles'
        ? `列「${cf.header}」同时像 ${cf.roles.join('/')}`
        : `存在多个候选表头行（第 ${cf.rows.map((r) => r + 1).join('、')} 行）`)).join('；');
    out.kind = 'column-conflict';
    out.code = 'column-mapping-conflict';
    out.notice = `列映射冲突：${desc}。已停止，需要人工指定列后再登记，不自动猜列、不写入任何单元格。`;
    return out;
  }

  const required = [mapping.taskId, mapping.platform];
  if (required.some((c) => c === undefined)) {
    out.kind = 'needs-binding';
    out.code = 'column-unmapped';
    out.notice = '未识别到计划表所需的「任务编号/平台」列，需要先完成列映射。';
    return out;
  }
  const header = findHeaderRow(rows, ['任务编号', '平台']);
  if (header.headerRow < 0) {
    out.kind = 'needs-binding';
    out.code = 'no-header';
    out.notice = '工作表中没有可识别的计划表头（需要「任务编号/平台」等字段）。';
    return out;
  }
  const start = header.headerRow + 1;
  const data = [];
  for (let r = start; r < rows.length; r += 1) {
    if (isDataRow(rows, r, mapping)) {
      const rawTaskId = cell(rows[r], mapping.taskId);
      const taskIdInfo = classifyTaskId(rawTaskId);
      data.push({
        index: r,
        taskId: taskIdInfo.normalized || rawTaskId,
        taskIdRaw: rawTaskId,
        taskIdCode: taskIdInfo.code,
        platform: cell(rows[r], mapping.platform),
        category: cell(rows[r], mapping.category),
        title: cell(rows[r], mapping.title),
        date: cell(rows[r], mapping.date),
        status: cell(rows[r], mapping.status),
        link: cell(rows[r], mapping.link),
      });
    }
  }
  out.totalRows = data.length;

  // 1) 任务编号：缺失 / 空 PL- / 格式非法 → 一律「需要绑定」，绝不继续往下猜。
  const plInfo = classifyTaskId(query?.plTaskId);
  if (plInfo.code !== 'ok') {
    out.kind = 'needs-binding';
    out.code = plInfo.code;
    out.notice = plInfo.code === 'invalid-task-id'
      ? `任务编号「${plInfo.value}」不符合规定格式（应为 ${PL_FORMAT_HINT}），登记前需要人工确认/绑定。`
      : plInfo.code === 'empty-pl-number'
        ? `任务编号只有「PL-」没有编号，不是合法任务编号（应为 ${PL_FORMAT_HINT}），登记前需要人工绑定。`
        : '文章没有绑定 PL-* 任务编号，登记前需要先绑定计划任务编号。';
    return out;
  }
  const pl = plInfo.normalized;
  const platform = String(query?.platform || '').trim();

  // 2) 按 PL + 平台定位；平台为空的行绝不静默当成命中。
  const idMatches = data.filter((d) => d.taskId === pl);
  if (platform) {
    const exact = idMatches.filter((d) => d.platform === platform);
    if (exact.length === 1) {
      out.kind = 'unique';
      out.code = 'ok';
      out.matched = exact[0];
      return out;
    }
    if (exact.length > 1) {
      out.kind = 'conflict';
      out.code = 'duplicate-rows';
      out.rows = exact;
      out.notice = `找到 ${exact.length} 行匹配（${pl} + ${platform}），立即停止，需要人工核对，不写入任何单元格。`;
      return out;
    }
    const blankPlatform = idMatches.filter((d) => !d.platform);
    if (blankPlatform.length) {
      out.kind = 'needs-binding';
      out.code = 'blank-platform';
      out.rows = blankPlatform;
      out.notice = `任务编号 ${pl} 有 ${blankPlatform.length} 行的「平台」为空，无法确认是否属于「${platform}」，需要人工绑定平台后再登记（未写入任何单元格）。`;
      return out;
    }
  } else if (idMatches.length === 1) {
    out.kind = 'unique';
    out.code = 'ok';
    out.matched = idMatches[0];
    return out;
  } else if (idMatches.length > 1) {
    out.kind = 'conflict';
    out.code = 'duplicate-rows';
    out.rows = idMatches;
    out.notice = `找到 ${idMatches.length} 行匹配（${pl}），立即停止，需要人工核对，不写入任何单元格。`;
    return out;
  }

  // 3) 0 行匹配 → 拟追加行预览（不写文件，仅展示即将追加的行内容与追加位置）。
  out.kind = 'append';
  out.code = 'zero-match';
  const appendRow = { index: data.length ? data[data.length - 1].index + 1 : start };
  appendRow.taskId = pl;
  appendRow.platform = platform || '(待选择平台)';
  appendRow.category = String(query?.category || '').trim();
  appendRow.title = String(query?.title || '').trim();
  appendRow.date = String(query?.date || '').trim();
  out.appendRow = appendRow;
  out.notice = `0 行匹配「${pl}${platform ? ` + ${platform}` : ''}」，下面是拟追加行预览（尚未写入 Excel）。`;
  return out;
}

/**
 * 工作表/列映射 + 行定位的只读预览（供测试与未来向导界面展示）。
 * @param {object} workbook  readXlsx() 的返回 { sheets: [{name, rows}] }
 * @param {object} query
 * @returns {object}
 */
export function previewRegistration({ workbook, sheetName, query, colMap }) {
  const shapes = (workbook.sheets || []).map((s) => ({
    name: s.name,
    rows: s.rows.length,
    cols: s.rows.reduce((n, r) => Math.max(n, r.length), 0),
    header: (s.rows[0] || []).join(' | '),
  }));
  const target = workbook.sheets.find((s) => !sheetName || s.name === sheetName);
  if (!target) {
    return { ok: false, error: sheetName ? `找不到工作表：${sheetName}` : '工作簿没有工作表', sheets: shapes };
  }
  const sniffed = sniffColumnMapping(target.rows);
  const resolution = resolvePlanRows({ rows: target.rows, colMap: colMap || sniffed.mapping, sniffed, query });
  return {
    ok: true,
    sheets: shapes,
    targetSheet: target.name,
    columnMapPreview: {
      suggested: sniffed.mapping,
      matched: sniffed.matched,
      unmatched: sniffed.unmatched,
      conflicts: sniffed.conflicts,
      ok: sniffed.ok,
    },
    resolution,
    readOnly: true,
  };
}
