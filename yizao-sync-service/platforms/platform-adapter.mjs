/**
 * Side-effect-free adapter contract for the current read-only/simulation build.
 * Real implementations must be introduced in a separately authorized phase.
 */
export class PlatformAdapter {
  constructor({ id, name, capabilities, workflow, aliases = [] }) {
    this.id = id;
    this.name = name;
    this.capabilities = Object.freeze({ ...capabilities });
    this.workflow = workflow;
    this.aliases = Object.freeze([...aliases]);
  }

  async checkLogin() {
    return { platform: this.id, checked: false, authenticated: false, reason: '当前模拟 Adapter 不访问真实账号' };
  }

  async prepare(context = {}) {
    if (typeof context.prepare !== 'function') {
      return { platform: this.id, prepared: false, simulatedOnly: true, reason: '未提供只读准备器' };
    }
    return context.prepare();
  }

  async validatePackage(context = {}) {
    if (typeof context.validatePackage !== 'function') {
      return { platform: this.id, valid: false, simulatedOnly: true, reason: '未提供包校验器' };
    }
    return context.validatePackage();
  }

  async createTask(context = {}) {
    if (!this.capabilities.simulate || typeof context.createSimulatedTask !== 'function') {
      return { platform: this.id, created: false, simulatedOnly: true, reason: '当前平台没有模拟任务实现' };
    }
    return context.createSimulatedTask();
  }

  async saveDraft() {
    return { platform: this.id, saved: false, allowed: false, reason: '当前构建禁止真实上传和保存草稿' };
  }

  async publish() {
    return { platform: this.id, published: false, allowed: false, reason: '当前构建禁止真实公开发布' };
  }

  async getStatus(context = {}) {
    return typeof context.getStatus === 'function'
      ? context.getStatus()
      : { platform: this.id, status: 'not_started', simulatedOnly: true };
  }
}

export class GuardedDraftPlatformAdapter extends PlatformAdapter {
  async checkLogin(context = {}) {
    return typeof context.checkLogin === 'function'
      ? context.checkLogin()
      : { platform: this.id, checked: false, authenticated: false, reason: '登录检查只能由扩展当前会话执行' };
  }

  async createTask(context = {}) {
    return typeof context.createDraftTask === 'function'
      ? context.createDraftTask()
      : { platform: this.id, created: false, reason: '未提供受保护的草稿任务创建器' };
  }

  async saveDraft(context = {}) {
    return typeof context.saveDraft === 'function'
      ? context.saveDraft()
      : { platform: this.id, saved: false, allowed: false, reason: '保存草稿必须经过 Stage 3 安全闸门' };
  }
}

export const SIMULATION_CAPABILITIES = Object.freeze({
  prepare: true,
  simulate: true,
  saveDraft: false,
  publish: false,
  autoPublish: false,
  imageAlt: true,
  visibleCaption: false,
  verified: false,
});
export const DRAFT_SIMULATION_CAPABILITIES = Object.freeze({
  prepare: true,
  simulate: true,
  saveDraft: false,
  publish: false,
  autoPublish: false,
  imageAlt: true,
  visibleCaption: true,
  verified: false,
});
export const GUARDED_DRAFT_CAPABILITIES = Object.freeze({
  prepare: true,
  simulate: true,
  saveDraft: false,
  publish: false,
  autoPublish: false,
  imageAlt: true,
  visibleCaption: false,
  verified: false,
  implementationAvailable: true,
});

export const UNSUPPORTED_CAPABILITIES = Object.freeze({
  prepare: false,
  simulate: false,
  saveDraft: false,
  publish: false,
  autoPublish: false,
  imageAlt: false,
  visibleCaption: false,
  verified: false,
});
