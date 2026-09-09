import { PlatformAdapter, DRAFT_SIMULATION_CAPABILITIES } from '../platform-adapter.mjs';

/**
 * 网易号当前只接入扩展本地草稿流程模拟。
 * Adapter 不访问账号、不上传内容，也不保存或发布真实稿件。
 */
export const neteaseAdapter = new PlatformAdapter({
  id: 'netease', name: '网易号', aliases: ['网易', '网易号'], workflow: 'draft-simulation',
  capabilities: DRAFT_SIMULATION_CAPABILITIES,
});
