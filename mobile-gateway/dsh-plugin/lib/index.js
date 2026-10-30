/**
 * mobile-gateway 插件 —— 宿主半边。
 *
 * 职责只有一件事：把网关的管理接口（`http://127.0.0.1:8788/admin/*`）转给设置页。
 * 为什么不在插件里直接读文件/改配置：
 *   · 模型改动必须让 ACP 子进程重开才生效，而**网关才是那个进程的爹**；
 *   · 配对码也只活在网关进程内存里。
 * 所以插件做代理，网关做真正的事——两边职责不重叠。
 */

import { CODES, fail, toFailure, ok, requireThat } from '../../src/errors.js';

export const name = 'mobile-gateway';
export const inject = ['webServer'];

const API = '/dsh-mobile-gateway/api';
const GATEWAY = 'http://127.0.0.1:8788';

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(text);
}

function isLoopback(req) {
  const ip = String(req.socket?.remoteAddress ?? '');
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

async function readBody(req, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) {
      const e = new Error('请求体过大');
      e.code = 'too-large';
      throw e;
    }
    chunks.push(c);
  }
  if (chunks.length === 0) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return null;
  }
}

/** 转发到网关。网关没起来时给出「怎么起」的 hint，而不是一个裸 ECONNREFUSED。 */
async function callGateway(pathname, init = {}) {
  let res;
  try {
    res = await fetch(`${GATEWAY}${pathname}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    const notRunning = e?.cause?.code === 'ECONNREFUSED' || e?.name === 'TimeoutError' || e?.code === 'ECONNREFUSED';
    throw fail(
      notRunning ? CODES.ACP_NOT_RUNNING : 'gateway.unreachable',
      notRunning ? '网关没在运行' : `连不上网关：${e?.message ?? e}`,
      { hint: notRunning ? '在手机网关目录双击 start-gateway.bat（或 node src/main.js --listen 0.0.0.0:8788）。' : '' },
    );
  }
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { ok: false, error: `网关返回了非 JSON（HTTP ${res.status}）` };
  }
  return { status: res.status, body };
}

export function apply(ctx) {
  const disposers = [];

  function route(method, pathname, handler) {
    disposers.push(
      ctx.webServer.register({
        kind: 'exact',
        path: pathname,
        handler: async (req, res) => {
          // 设置页在 DSH 自己的 web 界面里，天然是本机来源；仍然显式卡一道
          if (!isLoopback(req)) return json(res, 403, { ok: false, error: '只接受本机访问' });
          if (req.method !== method) return json(res, 405, { ok: false, error: '方法不对' });
          try {
            const out = await handler(req);
            json(res, 200, ok(out));
          } catch (e) {
            const failure = toFailure(e);
            json(res, Number.isInteger(e?.status) ? e.status : 200, failure);
          }
        },
      }),
    );
  }

  route('GET', `${API}/status`, async () => {
    const { status, body } = await callGateway('/admin/status');
    if (status !== 200 || !body?.ok) {
      // 网关没起来不算「插件坏了」：告诉设置页 running=false，它显示引导
      throw fail('gateway.down', body?.error ?? '网关没在运行', {
        hint: '双击手机网关目录里的 start-gateway.bat。',
      });
    }
    return { running: true, ...body };
  });

  route('POST', `${API}/pair`, async () => {
    const body = await (await callGateway('/admin/pair', { method: 'POST' })).body;
    if (!body?.ok) throw fail('gateway.error', body?.error ?? '生成配对码失败', {});
    return body;
  });

  route('GET', `${API}/acp-model`, async () => {
    const { body } = await callGateway('/admin/acp-model');
    if (!body?.ok) throw fail('gateway.error', body?.error ?? '读不到模型配置', {});
    return body;
  });

  route('PUT', `${API}/acp-model`, async (req) => {
    const payload = await readBody(req);
    requireThat(payload && payload.provider && payload.model, CODES.BAD_REQUEST, 'provider 和 model 都要填', {
      hint: '例如 deepseek-account / deepseek-v4.1-flash',
    });
    const { body } = await callGateway('/admin/acp-model', {
      method: 'PUT',
      body: JSON.stringify({ provider: String(payload.provider).trim(), model: String(payload.model).trim() }),
    });
    if (!body?.ok) throw fail('gateway.error', body?.error ?? '保存失败', { hint: body?.hint ?? '' });
    return body;
  });

  ctx.effect?.(() => () => {
    for (const d of disposers) {
      try {
        d?.();
      } catch {
        /* ignore */
      }
    }
  }, 'mobile-gateway: api routes');
}
