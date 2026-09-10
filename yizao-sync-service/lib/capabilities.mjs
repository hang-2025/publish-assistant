/**
 * 平台能力矩阵与真实动作闸门（阶段2J验收材料准备）。
 *
 * 这里不包含任何平台登录、上传、写表或归档实现。它只把“当前能做什么 /
 * 仍需验收什么 / 哪些真实动作必须另行授权”结构化，供工作台展示和未来执行器接入前校验。
 */

import { platformArchitectureMetadata } from '../platforms/registry.mjs';
import { ACCEPTANCE_BUILD, LOCAL_PROTOCOL, SERVICE_VERSION } from './build-info.mjs';

export const ACTIONS = {
  upload: '真实上传',
  saveDraft: '保存草稿',
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
    status: 'guarded-draft-unverified',
    currentActions: ['只读扫描', '扩展本地草稿流程模拟', '受保护的单篇 HTML 保真草稿实现（待真实账号人工验收）'],
    plannedActions: ['用专用测试账号完成一次真实草稿验收', '打开草稿给用户人工检查'],
    realActionPolicy: {
      upload: 'not-supported-as-standalone-action',
      saveDraft: 'stage3-explicit-confirmation-only',
      publish: 'not-supported',
      excelWrite: 'requires-explicit-authorization',
      archiveMove: 'requires-explicit-authorization',
    },
    evidence: ['自动测试覆盖 Canonical HTML、Caption=img.alt、平台回读保真、登录失败、重复任务、快照变化、图片失败与重启恢复'],
    risks: ['尚未使用专用知乎测试账号确认平台对各语义块与 140 字 Caption 验收策略的实际表现，因此 verified/saveDraft 仍为 false'],
  },
  {
    id: 'sohu',
    name: '搜狐号',
    group: '主流平台',
    status: 'guarded-draft-unverified',
    currentActions: ['只读扫描', '扩展本地草稿流程模拟', '受保护的单篇 HTML 保真草稿实现（待真实账号人工验收）'],
    plannedActions: ['用专用测试账号完成一次真实草稿验收', '打开草稿给用户人工检查'],
    realActionPolicy: {
      upload: 'not-supported-as-standalone-action',
      saveDraft: 'stage4-explicit-confirmation-only',
      publish: 'not-supported',
      excelWrite: 'requires-explicit-authorization',
      archiveMove: 'requires-explicit-authorization',
    },
    evidence: ['自动测试覆盖 HTML/图注回读、登录失败、任务授权、快照变化、图片失败与公开发布拒绝'],
    risks: ['尚未使用专用搜狐号测试账号确认平台对表格、图片锚点与可见图注的实际保存行为，因此 verified/saveDraft 仍为 false'],
  },
  {
    id: 'toutiao',
    name: '头条号',
    group: '主流平台',
    status: 'guarded-draft-unverified',
    currentActions: ['只读扫描', '受保护的单篇 HTML 保真草稿实现（待真实账号人工验收）'],
    plannedActions: ['用专用测试账号完成一次真实草稿验收', '打开草稿给用户人工检查'],
    realActionPolicy: {
      upload: 'not-supported-as-standalone-action',
      saveDraft: 'stage5-explicit-confirmation-only',
      publish: 'not-supported',
      excelWrite: 'requires-explicit-authorization',
      archiveMove: 'requires-explicit-authorization',
    },
    evidence: ['头条号当前官方编辑器接口与 save=0 草稿语义已核对；自动测试覆盖任务授权、回读保真、图片图注与公开发布拒绝'],
    risks: ['尚未使用专用头条号测试账号确认官方风控、图片描述和语义块的实际保存行为，因此 verified/saveDraft 仍为 false'],
  },
  {
    id: 'netease',
    name: '网易号',
    group: '主流平台',
    status: 'guarded-draft-unverified',
    currentActions: ['只读扫描', '受保护的单篇 HTML 保真草稿实现（待真实账号人工验收）'],
    plannedActions: ['用专用测试账号完成一次真实草稿验收', '打开草稿给用户人工检查'],
    realActionPolicy: {
      upload: 'not-supported-as-standalone-action',
      saveDraft: 'stage6-explicit-confirmation-only',
      publish: 'not-supported',
      excelWrite: 'requires-explicit-authorization',
      archiveMove: 'requires-explicit-authorization',
    },
    evidence: ['网易号官方编辑器 saveDraft 语义、官方风控令牌与回读接口已核对；自动测试覆盖任务授权、图片图注、回读保真与公开发布拒绝'],
    risks: ['尚未使用专用网易号测试账号确认风控、图片说明和语义块的实际保存行为，因此 verified/saveDraft 仍为 false'],
  },
  {
    id: 'xiaohongshu',
    name: '小红书',
    group: '主流平台',
    status: 'guarded-draft-unverified',
    currentActions: ['只读扫描', '受保护的单篇图文草稿实现（待真实账号人工验收）'],
    plannedActions: ['用专用测试账号完成一次真实草稿验收', '打开草稿给用户人工检查'],
    realActionPolicy: {
      upload: 'not-supported-as-standalone-action',
      saveDraft: 'stage7-explicit-confirmation-only',
      publish: 'not-supported',
      excelWrite: 'requires-explicit-authorization',
      archiveMove: 'requires-explicit-authorization',
    },
    evidence: ['自动测试覆盖任务授权、草稿库回读、标题正文图片数量校验与公开发布拒绝'],
    risks: ['网页端结构可能变化；尚未使用专用小红书测试账号完成人工验收，因此 verified/saveDraft 仍为 false'],
  },
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
    phase: '7-xiaohongshu-draft-unverified',
    generatedAt: new Date().toISOString(),
    realActionsEnabled: false,
    runtime: {
      serviceVersion: SERVICE_VERSION,
      protocol: LOCAL_PROTOCOL,
      acceptanceBuildId: ACCEPTANCE_BUILD.id,
      requiredExtensionBuildId: ACCEPTANCE_BUILD.extensionBuildId,
    },
    requirementsBeforeRealActions: BASE_REQUIREMENTS,
    actions: ACTIONS,
    platforms: PLATFORM_CAPABILITIES,
  };
}

export function checkRealActionGate({ action, platform, authorization } = {}) {
  const actionKey = String(action || '').trim();
  const platformKey = String(platform || '').trim();
  const platformInfo = PLATFORM_CAPABILITIES.find((p) => p.id === platformKey) || null;
  const knownAction = Object.prototype.hasOwnProperty.call(ACTIONS, actionKey);
  const policy = platformInfo?.realActionPolicy?.[actionKey] || (knownAction ? 'requires-explicit-authorization' : 'unknown-action');
  const stage3DraftAllowed = actionKey === 'saveDraft'
    && platformKey === 'zhihu'
    && authorization?.stage === '3-zhihu-draft'
    && authorization?.userConfirmed === true
    && authorization?.snapshotVerified === true;
  const stage4SohuDraftAllowed = actionKey === 'saveDraft'
    && platformKey === 'sohu'
    && authorization?.stage === '4-sohu-draft'
    && authorization?.userConfirmed === true
    && authorization?.snapshotVerified === true;
  const stage5ToutiaoDraftAllowed = actionKey === 'saveDraft'
    && platformKey === 'toutiao'
    && authorization?.stage === '5-toutiao-draft'
    && authorization?.userConfirmed === true
    && authorization?.snapshotVerified === true;
  const stage6NeteaseDraftAllowed = actionKey === 'saveDraft'
    && platformKey === 'netease'
    && authorization?.stage === '6-netease-draft'
    && authorization?.userConfirmed === true
    && authorization?.snapshotVerified === true;
  const stage7XiaohongshuDraftAllowed = actionKey === 'saveDraft'
    && platformKey === 'xiaohongshu'
    && authorization?.stage === '7-xiaohongshu-draft'
    && authorization?.userConfirmed === true
    && authorization?.snapshotVerified === true;
  const guardedDraftAllowed = stage3DraftAllowed || stage4SohuDraftAllowed || stage5ToutiaoDraftAllowed
    || stage6NeteaseDraftAllowed || stage7XiaohongshuDraftAllowed;
  return {
    allowed: guardedDraftAllowed,
    action: actionKey,
    actionName: ACTIONS[actionKey] || actionKey || '未知动作',
    platform: platformKey,
    platformName: platformInfo?.name || platformKey || '未知平台',
    policy,
    reason: guardedDraftAllowed
      ? `仅允许当前已确认且快照复核通过的单篇${platformInfo?.name || platformKey}保存草稿动作；不包含公开发布。`
      : knownAction
      ? '真实动作默认关闭。仅独立验收阶段中经用户当次确认、快照复核通过的知乎、搜狐号、头条号、网易号或小红书 saveDraft 可获准。'
      : '未知真实动作不在允许清单中。',
    requirements: BASE_REQUIREMENTS,
  };
}
