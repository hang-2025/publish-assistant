import { GuardedDraftPlatformAdapter, GUARDED_DRAFT_CAPABILITIES } from '../platform-adapter.mjs';

export const toutiaoAdapter = new GuardedDraftPlatformAdapter({
  id: 'toutiao', name: '头条号', aliases: ['头条', '头条号'], workflow: 'guarded-draft',
  capabilities: GUARDED_DRAFT_CAPABILITIES,
});
