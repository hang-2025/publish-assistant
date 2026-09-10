import { GuardedDraftPlatformAdapter, GUARDED_DRAFT_CAPABILITIES } from '../platform-adapter.mjs';

/**
 * 网易号只允许经本地服务当次确认、不可变快照复核的单篇草稿握手。
 * 公开发布能力不存在，capabilities 在真实账号验收前继续保持 false。
 */
export const neteaseAdapter = new GuardedDraftPlatformAdapter({
  id: 'netease', name: '网易号', aliases: ['网易', '网易号'], workflow: 'guarded-draft',
  capabilities: GUARDED_DRAFT_CAPABILITIES,
});
