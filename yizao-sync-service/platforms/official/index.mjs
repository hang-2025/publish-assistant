import { PlatformAdapter, SIMULATION_CAPABILITIES } from '../platform-adapter.mjs';

export class OfficialPlatformAdapter extends PlatformAdapter {
  constructor({ id, name, aliases = [] }) {
    super({ id, name, aliases, workflow: 'official-simulation', capabilities: SIMULATION_CAPABILITIES });
  }
}

export const officialAdapters = [
  new OfficialPlatformAdapter({ id: 'eyzao.com', name: '易造官网（eyzao.com）', aliases: ['www.eyzao.com'] }),
  new OfficialPlatformAdapter({ id: 'eyzao.cn', name: '易造官网（eyzao.cn）', aliases: ['www.eyzao.cn'] }),
  new OfficialPlatformAdapter({ id: 'yzfanglei.com', name: '易造防雷官网（yzfanglei.com）', aliases: ['www.yzfanglei.com'] }),
];
