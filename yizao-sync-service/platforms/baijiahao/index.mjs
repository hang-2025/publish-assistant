import { PlatformAdapter, SIMULATION_CAPABILITIES } from '../platform-adapter.mjs';

export const baijiahaoAdapter = new PlatformAdapter({
  id: 'baijiahao',
  name: '百家号',
  aliases: ['百家号'],
  workflow: 'official-simulation',
  capabilities: SIMULATION_CAPABILITIES,
});
