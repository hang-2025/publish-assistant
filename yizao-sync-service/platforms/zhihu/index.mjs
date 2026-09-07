import { GuardedDraftPlatformAdapter, GUARDED_DRAFT_CAPABILITIES } from '../platform-adapter.mjs';

export const zhihuAdapter = new GuardedDraftPlatformAdapter({
  id: 'zhihu', name: '知乎', aliases: ['知乎'], workflow: 'guarded-draft',
  capabilities: GUARDED_DRAFT_CAPABILITIES,
});
