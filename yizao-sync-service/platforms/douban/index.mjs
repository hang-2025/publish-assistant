import { GuardedDraftPlatformAdapter, GUARDED_DRAFT_CAPABILITIES } from '../platform-adapter.mjs';

export const doubanAdapter = new GuardedDraftPlatformAdapter({
  id: 'douban', name: '豆瓣', aliases: ['豆瓣', 'douban'], workflow: 'guarded-draft',
  capabilities: GUARDED_DRAFT_CAPABILITIES,
});
