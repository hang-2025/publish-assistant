import { startApplication } from './services/application.mjs';

/** Minimal process entry point. */
startApplication().catch((err) => {
  console.error('启动失败：', err);
  process.exit(1);
});
