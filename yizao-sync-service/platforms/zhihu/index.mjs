import { PlatformAdapter, DRAFT_SIMULATION_CAPABILITIES } from '../platform-adapter.mjs';

export const zhihuAdapter = new PlatformAdapter({
  id: 'zhihu', name: '知乎', aliases: ['知乎'], workflow: 'draft-simulation',
  capabilities: DRAFT_SIMULATION_CAPABILITIES,
});
