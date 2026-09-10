import { GuardedDraftPlatformAdapter, GUARDED_DRAFT_CAPABILITIES } from '../platform-adapter.mjs';

export const xiaohongshuAdapter = new GuardedDraftPlatformAdapter({
  id: 'xiaohongshu',
  name: '小红书',
  aliases: ['小红书', 'xiaohongshu'],
  workflow: 'guarded-draft',
  capabilities: GUARDED_DRAFT_CAPABILITIES,
});
