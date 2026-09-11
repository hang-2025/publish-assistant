import type { PlatformMeta } from '@wechatsync/core'

/** 后台自动预热不得触发会打开编辑页的交互式登录检查。 */
export function shouldAutoCheckPlatformAuth(meta: PlatformMeta): boolean {
  return meta.authCheckMode !== 'interactive'
}
