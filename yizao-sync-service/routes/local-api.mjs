import http from 'node:http';
import crypto from 'node:crypto';

function send(res, status, obj, origin) {
  const headers = { 'Content-Type': 'application/json; charset=utf-8' };
  if (origin) headers['Access-Control-Allow-Origin'] = origin;
  res.writeHead(status, headers);
  res.end(JSON.stringify(obj));
}
export function isTrustedHost(req, port) {
  const host = (req.headers.host || '').toLowerCase();
  return host === `127.0.0.1:${port}` || host === `localhost:${port}` || host === `[::1]:${port}`;
}

export function trustedExtensionOrigin(req) {
  const origin = req.headers.origin;
  return origin && /^chrome-extension:\/\/[a-p]{32}$/i.test(origin)
    ? { ok: true, origin }
    : { ok: false, origin: null };
}

function validBearerToken(auth, expectedToken) {
  const match = String(auth || '').match(/^Bearer\s+([0-9a-f]{64})$/i);
  return Boolean(match && expectedToken
    && crypto.timingSafeEqual(Buffer.from(match[1], 'hex'), Buffer.from(expectedToken, 'hex')));
}

/**
 * HTTP transport boundary. Business commands are supplied through commandRouter;
 * this module only receives, authenticates, parses, dispatches and responds.
 */
export function createLocalApiServer({
  port,
  version,
  protocol,
  maxBodyBytes,
  commandRouter,
  getToken,
  bindOrVerifyOrigin,
  logger = console,
}) {
  return http.createServer(async (req, res) => {
    const log = (status) => logger.log(`[${new Date().toISOString()}] ${req.method} ${req.url} -> ${status}`);
    try {
      if (!isTrustedHost(req, port)) { send(res, 403, { error: '拒绝：Host 不受信任' }); log(403); return; }

      if (req.method === 'OPTIONS') {
        const { ok, origin } = trustedExtensionOrigin(req);
        if (!ok) { send(res, 403, { error: '拒绝：Origin 不受信任' }); log(403); return; }
        res.writeHead(204, {
          'Access-Control-Allow-Origin': origin,
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Authorization, Content-Type',
          'Access-Control-Max-Age': '600',
        });
        res.end();
        return;
      }

      if (req.method === 'GET' && req.url === '/api/health') {
        send(res, 200, { ok: true, name: 'yizao-sync-service', version, protocol });
        log(200);
        return;
      }

      if (req.method === 'POST' && req.url === '/api/command') {
        const { ok: originOk, origin } = trustedExtensionOrigin(req);
        if (!originOk) { send(res, 403, { error: '拒绝：仅允许插件内部页面调用（Origin 不受信任）' }); log(403); return; }
        if (!validBearerToken(req.headers.authorization, getToken())) {
          send(res, 401, { error: '未配对或令牌无效' }, origin);
          log(401);
          return;
        }
        if (!(await bindOrVerifyOrigin(origin))) {
          send(res, 403, { error: '拒绝：该服务已与另一个扩展配对' }, origin);
          log(403);
          return;
        }

        let body = '';
        let bodyBytes = 0;
        for await (const chunk of req) {
          bodyBytes += chunk.length;
          if (bodyBytes > maxBodyBytes) { send(res, 413, { error: '请求体过大' }, origin); log(413); req.destroy(); return; }
          body += chunk;
        }
        let message;
        try { message = JSON.parse(body || '{}'); }
        catch { send(res, 400, { error: '请求体不是有效 JSON' }, origin); log(400); return; }

        if (!commandRouter.names.includes(message.command)) {
          send(res, 400, { error: `未知命令：${String(message.command).slice(0, 40)}（白名单：${commandRouter.names.join(', ')}）` }, origin);
          log(400);
          return;
        }
        try {
          const result = await commandRouter.dispatch(message);
          send(res, 200, { ok: true, ...result }, origin);
          log(200);
        } catch (err) {
          send(res, 422, { ok: false, error: err.message }, origin);
          log(422);
        }
        return;
      }

      send(res, 404, { error: 'Not Found' });
      log(404);
    } catch (err) {
      logger.error(`[${new Date().toISOString()}] 处理异常：${err.message}`);
      try { send(res, 500, { error: '服务器内部错误' }); } catch { /* 已响应 */ }
    }
  });
}
