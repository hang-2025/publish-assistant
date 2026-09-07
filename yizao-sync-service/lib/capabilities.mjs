/**
 * 平台能力矩阵与真实动作闸门（阶段2J验收材料准备）。
 *
 * 这里不包含任何平台登录、上传、写表或归档实现。它只把“当前能做什么 /
 * 仍需验收什么 / 哪些真实动作必须另行授权”结构化，供工作台展示和未来执行器接入前校验。
 */

import { platformArchitectureMetadata } from '../platforms/registry.mjs';

export const ACTIONS = {
  upload: '真实上传/保存草稿',
  publish: '公开发布',
  excelWrite: 'Excel 写入登记',
  archiveMove: '移动/归档文章包',
};

const BASE_REQUIREMENTS = [
  '用户在当前会话明确授权真实动作',
  '确认未使用旧助手 Chrome 登录资料目录',
  '确认旧助手未占用同一账号/站点执行流程',
  '发送快照、Excel 匹配、归档预演均通过',
];

const LEGACY_PLATFORM_CAPABILITIES = [
  {
    id: 'eyzao.com',
    name: '易造官网（eyzao.com）',
    group: '官网',
    status: 'simulation-ready',
    currentActions: ['只读扫描', '发送快照预览', '模拟发布流程', 'Excel 登记只读预览'],
    plannedActions: ['真实后台填写后等待用户最终提交', '确认发布结果后登记/归档'],
    realActionPolicy: {
      upload: 'requires-explicit-authorization',
      publish: 'manual-final-submit-only',
      excelWrite: 'requires-explicit-authorization',
      archiveMove: 'requires-explicit-authorization',
    },
    evidence: ['阶段1B/1C 自动测试覆盖官网包快照、模拟状态机、包↔站点绑定'],
    risks: ['真实执行器尚未接入新服务；旧助手未接入新锁协议'],
  },
  {
    id: 'eyzao.cn',
    name: '易造官网（eyzao.cn）',
    group: '官网',
    status: 'simulation-ready',
    currentActions: ['只读扫描', '发送快照预览', '模拟发布流程', 'Excel 登记只读预览'],
    plannedActions: ['真实后台填写后等待用户最终提交', '确认发布结果后登记/归档'],
    realActionPolicy: {
      upload: 'requires-explicit-authorization',
      publish: 'manual-final-submit-only',
      excelWrite: 'requires-explicit-authorization',
      archiveMove: 'requires-explicit-authorization',
    },
    evidence: ['阶段1B 自动测试覆盖 eyzao.cn 站点锁与包↔站点绑定'],
    risks: ['真实栏目映射仍需用站点配置验收'],
  },
  {
    id: 'yzfanglei.com',
    name: '易造防雷官网（yzfanglei.com）',
    group: '官网',
    status: 'simulation-ready',
    currentActions: ['只读扫描', '发送快照预览', '模拟发布流程', 'Excel 登记只读预览'],
    plannedActions: ['真实后台填写后等待用户最终提交', '确认发布结果后登记/归档'],
    realActionPolicy: {
      upload: 'requires-explicit-authorization',
      publish: 'manual-final-submit-only',
      excelWrite: 'requires-explicit-authorization',
      archiveMove: 'requires-explicit-authorization',
    },
    evidence: ['站点键已在服务端站点表中登记；真实执行未验收'],
    risks: ['真实栏目映射仍需用站点配置验收'],
  },
  {
    id: 'baijiahao',
    name: '百家号',
    group: '主流平台',
    status: 'simulation-ready',
    currentActions: ['只读扫描', '发送快照预览', '模拟发布流程', 'Excel 登记只读预览'],
    plannedActions: ['复用原流程填写后台后等待用户最终提交', '确认发布结果后登记/归档'],
    realActionPolicy: {
      upload: 'requires-explicit-authorization',
      publish: 'manual-final-submit-only',
      excelWrite: 'requires-explicit-authorization',
      archiveMove: 'requires-explicit-authorization',
    },
    evidence: ['阶段1B 自动测试使用真实百家号目录夹具，不再用官网包冒充'],
    risks: ['真实账号与后台页面未在新服务中验收'],
  },
  {
    id: 'zhihu',
    name: '知乎',
    group: '主流平台',
    status: 'draft-simulation',
    currentActions: ['只读扫描', '扩展本地草稿流程模拟'],
    plannedActions: ['保存草稿', '打开草稿给用户人工发布'],
    realActionPolicy: {
      upload: 'requires-explicit-authorization',
      publish: 'not-supported',
      excelWrite: 'requires-explicit-authorization',
      archiveMove: 'requires-explicit-authorization',
    },
    evidence: ['用户反馈排版大体正常；仍需结构化真实草稿验收'],
    risks: ['未接入结果回读与草稿 URL 持久登记'],
  },
  {
    id: 'sohu',
    name: '搜狐号',
    group: '主流平台',
    status: 'draft-simulation',
    currentActions: ['只读扫描', '扩展本地草稿流程模拟'],
    plannedActions: ['保存草稿', '表格兼容策略预览后确认'],
    realActionPolicy: {
      upload: 'requires-explicit-authorization',
      publish: 'not-supported',
      excelWrite: 'requires-explicit-authorization',
      archiveMove: 'requires-explicit-authorization',
    },
    evidence: ['公开源码存在适配器；用户反馈搜狐表格存在问题'],
    risks: ['表格保真、转条目、转图片方案均未验收'],
  },
  ...['toutiao', 'netease', 'xiaohongshu'].map((id) => ({
    id,
    name: ({ toutiao: '头条号', netease: '网易号', xiaohongshu: '小红书' })[id],
    group: '待适配平台',
    status: 'not-adapted',
    currentActions: ['只读扫描'],
    plannedActions: ['平台能力调研', '小样本草稿验收'],
    realActionPolicy: {
      upload: 'not-supported',
      publish: 'not-supported',
      excelWrite: 'requires-explicit-authorization',
      archiveMove: 'requires-explicit-authorization',
    },
    evidence: ['当前开发副本未验证可用适配器'],
    risks: ['不得显示发布或草稿成功'],
  })),
];

const architectureById = new Map(platformArchitectureMetadata().map((item) => [item.id, item]));

/**
 * Backward-compatible capability records. Existing fields remain unchanged;
 * the normalized fields are additive and are the source for new UI decisions.
 */
export const PLATFORM_CAPABILITIES = LEGACY_PLATFORM_CAPABILITIES.map((platform) => ({
  ...platform,
  ...(architectureById.get(platform.id) || {}),
}));

export function getCapabilities() {
  return {
    version: 2,
    phase: '2J-acceptance-materials',
    generatedAt: new Date().toISOString(),
    realActionsEnabled: false,
    requirementsBeforeRealActions: BASE_REQUIREMENTS,
    actions: ACTIONS,
    platforms: PLATFORM_CAPABILITIES,
  };
}

export function checkRealActionGate({ action, platform }) {
  const actionKey = String(action || '').trim();
  const platformKey = String(platform || '').trim();
  const platformInfo = PLATFORM_CAPABILITIES.find((p) => p.id === platformKey) || null;
  const knownAction = Object.prototype.hasOwnProperty.call(ACTIONS, actionKey);
  const policy = platformInfo?.realActionPolicy?.[actionKey] || (knownAction ? 'requires-explicit-authorization' : 'unknown-action');
  return {
    allowed: false,
    action: actionKey,
    actionName: ACTIONS[actionKey] || actionKey || '未知动作',
    platform: platformKey,
    platformName: platformInfo?.name || platformKey || '未知平台',
    policy,
    reason: knownAction
      ? '当前构建是只读/模拟版本，真实动作未启用。需要用户另行授权、执行器验收和回退方案确认后，才能进入真实阶段。'
      : '未知真实动作不在允许清单中。',
    requirements: BASE_REQUIREMENTS,
  };
}
