import { GuardedDraftPlatformAdapter, GUARDED_DRAFT_CAPABILITIES } from '../platform-adapter.mjs';

export const sohuAdapter = new GuardedDraftPlatformAdapter({
  id: 'sohu', name: '搜狐号', aliases: ['搜狐', '搜狐号'], workflow: 'guarded-draft',
  capabilities: GUARDED_DRAFT_CAPABILITIES,
});
