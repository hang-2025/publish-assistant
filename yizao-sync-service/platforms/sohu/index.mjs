import { PlatformAdapter, DRAFT_SIMULATION_CAPABILITIES } from '../platform-adapter.mjs';

export const sohuAdapter = new PlatformAdapter({
  id: 'sohu', name: '搜狐号', aliases: ['搜狐', '搜狐号'], workflow: 'draft-simulation',
  capabilities: DRAFT_SIMULATION_CAPABILITIES,
});
