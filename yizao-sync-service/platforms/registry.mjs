import { officialAdapters } from './official/index.mjs';
import { baijiahaoAdapter } from './baijiahao/index.mjs';
import { zhihuAdapter } from './zhihu/index.mjs';
import { sohuAdapter } from './sohu/index.mjs';
import { neteaseAdapter } from './netease/index.mjs';
import { toutiaoAdapter } from './toutiao/index.mjs';
import { xiaohongshuAdapter } from './xiaohongshu/index.mjs';

export class PlatformRegistry {
  #adapters = new Map();

  constructor(adapters = []) { adapters.forEach((adapter) => this.register(adapter)); }
  register(adapter) {
    if (!adapter?.id || this.#adapters.has(adapter.id)) throw new Error(`平台 Adapter 重复或无效：${adapter?.id || ''}`);
    this.#adapters.set(adapter.id, adapter);
    return adapter;
  }
  get(idOrAlias) {
    const key = String(idOrAlias || '').toLowerCase();
    return [...this.#adapters.values()].find((adapter) =>
      adapter.id.toLowerCase() === key || adapter.aliases.some((alias) => alias.toLowerCase() === key)) || null;
  }
  list() { return [...this.#adapters.values()]; }
}
export const platformRegistry = new PlatformRegistry([
  ...officialAdapters, baijiahaoAdapter, zhihuAdapter, sohuAdapter, toutiaoAdapter, neteaseAdapter, xiaohongshuAdapter,
]);

export function platformArchitectureMetadata() {
  return platformRegistry.list().map((adapter) => ({
    id: adapter.id,
    aliases: [...adapter.aliases],
    workflow: adapter.workflow,
    capabilities: { ...adapter.capabilities },
  }));
}
