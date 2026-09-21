import { GuardedDraftPlatformAdapter, GUARDED_DRAFT_CAPABILITIES } from '../platform-adapter.mjs';

export const douyinAdapter = new GuardedDraftPlatformAdapter({
  id: 'douyin', name: '抖音', aliases: ['抖音', 'douyin', 'dy'], workflow: 'guarded-draft',
  capabilities: GUARDED_DRAFT_CAPABILITIES,
});
