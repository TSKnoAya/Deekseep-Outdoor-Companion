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
import { startGateway, stopGateway, gatewayStatus } from './gateway-process.js';

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
  /** pathname → { GET: fn, PUT: fn }；DSH 的 webServer 按路径建路由，同路径重复注册会只剩一个方法。 */
  const byPath = new Map();

  function route(method, pathname, handler) {
    let table = byPath.get(pathname);
    if (!table) {
      table = Object.create(null);
      byPath.set(pathname, table);
      disposers.push(
        ctx.webServer.register({
          kind: 'exact',
          path: pathname,
          handler: async (req, res) => {
            // 设置页在 DSH 自己的 web 界面里，天然是本机来源；仍然显式卡一道
            if (!isLoopback(req)) return json(res, 403, { ok: false, error: '只接受本机访问' });
            const fn = table[String(req.method ?? '').toUpperCase()];
            if (!fn) return json(res, 405, { ok: false, error: '方法不对' });
            try {
              const out = await fn(req);
              json(res, 200, ok(out));
            } catch (e) {
              const failure = toFailure(e);
              json(res, Number.isInteger(e?.status) ? e.status : 200, failure);
            }
          },
        }),
      );
    }
    table[method] = handler;
  }

  route('GET', `${API}/status`, async () => {
    const local = gatewayStatus();
    try {
      const { status, body } = await callGateway('/admin/status');
      if (status === 200 && body?.ok) {
        return { running: true, managed: local.managed, log: local.log, ...body };
      }
    } catch {
      /* 网关没在跑是正常状态，不是错误：下面返回可行动的信息 */
    }
    return {
      running: false,
      managed: local.managed,
      log: local.log,
      lastError: local.lastError,
      hint: '点「启动网关」即可（用的是和 start-gateway.bat 相同的参数），不用开命令行。',
    };
  });

  /**
   * 从设置页启动网关。
   *
   * 为什么放在插件宿主里做：网关是 DSH 之外的独立进程，但「用户按了一下按钮」
   * 这件事只有 DSH 进程知道；让用户去双击 bat 等于把失败留给「他忘了开窗口」。
   */
  route('POST', `${API}/start`, async () => {
    const result = await startGateway();
    return { ...result, ...gatewayStatus() };
  });

  route('POST', `${API}/stop`, async () => {
    const stopped = await stopGateway();
    if (!stopped) {
      throw fail('gateway.not-managed', '这个网关不是从 DSH 启动的，这里停不掉', {
        hint: '双击 start-gateway.bat 起的网关，关掉那个黑窗口就行。',
      });
    }
    return { stopped: true, ...gatewayStatus() };
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

  /**
   * 「角色上下文」：把手上的鱼（SurfCore 的人格卡 + 记忆卡）带到手机。
   *
   * 插件只做转发：真正读文件、决定注入时机的是网关——
   * 因为只有网关知道「这一轮是第几轮」「上一个前缀还在不在上下文里」。
   */
  /** 已配对设备（列出 / 吊销）。丢了手机或换机时用。 */
  route('GET', `${API}/devices`, async () => {
    const { body } = await callGateway('/admin/devices');
    if (!body?.ok) throw fail('gateway.error', body?.error ?? '读不到设备列表', {});
    return body;
  });

  route('POST', `${API}/devices/revoke`, async (req) => {
    const payload = await readBody(req);
    const all = payload?.all === true;
    const id = String(payload?.id ?? '').trim();
    requireThat(all || Boolean(id), CODES.BAD_REQUEST, '要传 id，或用 all=true 清空', {});
    const { body } = await callGateway('/admin/devices/revoke', {
      method: 'POST',
      body: JSON.stringify(all ? { all: true } : { id }),
    });
    if (!body?.ok) throw fail('gateway.error', body?.error ?? '吊销失败', { hint: body?.hint ?? '' });
    return body;
  });

  route('GET', `${API}/persona`, async () => {
    const { body } = await callGateway('/admin/persona');
    if (!body?.ok) throw fail('gateway.error', body?.error ?? '读不到角色上下文状态', {});
    return body;
  });

  route('PUT', `${API}/persona`, async (req) => {
    const payload = await readBody(req);
    const hasEnabled = typeof payload?.enabled === 'boolean';
    const hasCharacter = payload?.characterId === null || typeof payload?.characterId === 'string';
    requireThat(hasEnabled || hasCharacter, CODES.BAD_REQUEST, 'enabled 或 characterId 至少要给一个', {
      hint: 'characterId 传角色 id；null 表示跟随桌面当前角色。',
    });
    const patch = {};
    if (hasEnabled) patch.enabled = payload.enabled;
    if (hasCharacter) patch.characterId = payload.characterId;
    const { body } = await callGateway('/admin/persona', {
      method: 'PUT',
      body: JSON.stringify(patch),
    });
    if (!body?.ok) throw fail('gateway.error', body?.error ?? '改不动角色上下文设置', {});
    return body;
  });

  /**
   * DSH 里*真正可用*的 provider / model 清单。
   *
   * 用 `ctx.llm`（DSH 的 LLM 注册表）：provider 是已加载的适配器，
   * model 是各适配器自报的型号。这样设置页能给出下拉选项，用户不用猜字符串。
   * 注意：某个 provider 查模型失败不能拖垮整张清单（第三方路由经常半死不活）。
   */
  route('GET', `${API}/models`, async () => {
    const llm = ctx.get('llm');
    if (!llm || typeof llm.listProviders !== 'function') {
      throw fail('llm.unavailable', 'DSH 没有提供模型服务', {
        hint: '检查 DSH 的 llm 插件是否加载；也可以在下面手动填写 provider / model。',
      });
    }
    const providers = llm.listProviders() ?? [];
    const groups = [];
    for (const p of providers) {
      const id = String(p?.id ?? p?.name ?? '');
      if (!id) continue;
      let models = [];
      try {
        models = (await llm.listModels(id)) ?? [];
      } catch (e) {
        // 记录但不抛出：让其它 provider 的模型照常显示
        groups.push({ id, name: String(p?.name ?? id), models: [], error: e?.message ?? String(e) });
        continue;
      }
      groups.push({
        id,
        name: String(p?.name ?? id),
        models: models.map((m) => ({ id: String(m?.id ?? m?.name ?? ''), name: String(m?.name ?? m?.id ?? '') })).filter((m) => m.id),
      });
    }
    return { providers: groups };
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

  // DSH 退出/重载插件时，把「按钮启动的」网关一起收掉：
  // 否则会留下一个没有窗口、用户在界面上也停不掉的隐藏进程。
  // 手动用 start-gateway.bat 起的网关不受影响（它不是我们管的）。
  ctx.effect?.(() => () => {
    stopGateway().catch(() => {});
  }, 'mobile-gateway: stop managed gateway');
}
