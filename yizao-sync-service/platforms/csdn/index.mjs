import { GuardedDraftPlatformAdapter, GUARDED_DRAFT_CAPABILITIES } from '../platform-adapter.mjs';

export const csdnAdapter = new GuardedDraftPlatformAdapter({
  id: 'csdn', name: 'CSDN', aliases: ['CSDN', 'csdn', '博客CSDN'], workflow: 'guarded-draft',
  capabilities: GUARDED_DRAFT_CAPABILITIES,
});
