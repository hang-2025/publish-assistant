/** Whitelist-only command dispatcher shared by the local HTTP route. */
export function createCommandRouter(commands) {
  const whitelist = Object.freeze({ ...commands });
  return {
    names: Object.freeze(Object.keys(whitelist)),
    async dispatch(message = {}) {
      const handler = whitelist[message.command];
      if (!handler) {
        const command = String(message.command).slice(0, 40);
        const error = new Error(`未知命令：${command}（白名单：${Object.keys(whitelist).join(', ')}）`);
        error.code = 'UNKNOWN_COMMAND';
        throw error;
      }
      return handler(message.payload || {});
    },
  };
}
