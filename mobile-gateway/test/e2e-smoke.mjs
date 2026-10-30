#!/usr/bin/env node
/**
 * 端到端冒烟：不需要手机，用 curl 等价物把整条链跑一遍。
 *
 *   起网关（子进程） → 抠出配对码 → 配对拿令牌 → 建会话 → 开 SSE → 发一句话
 *   → 等 turn_end → 打印收到的文本块 → 关网关
 *
 * 为什么要有这个脚本：单测全用假 transport，`agent_message_chunk` 的真实样本
 * 一条都没有。真机之前先跑这个，能确认「网关 ↔ DSH 的流式回包」这条最要紧的
 * 路是通的；剩下才轮到手机、网络、权限。
 *
 * **需要本机有真 DSH 且已登录**，所以不进 test/run-all.js（CI 里跑不了）。
 *
 * 用法：
 *   node test/e2e-smoke.mjs
 *   node test/e2e-smoke.mjs --port 8799 --text "只回复两个字：收到"
 */

import { spawn } from 'node:child_process';
import process from 'node:process';

const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : fallback;
};

const PORT = Number(argOf('--port', 8791));
const TEXT = argOf('--text', '只回复两个字：收到');
const BASE = `http://127.0.0.1:${PORT}`;
const TIMEOUT_MS = Number(argOf('--timeout', 90_000));

const log = (...a) => console.log('[e2e]', ...a);
const die = (msg) => {
  console.error(`[e2e] 失败：${msg}`);
  process.exitCode = 1;
};

function startGateway() {
  // 带 --pair：否则配对过一次设备后就不再自动打码，脚本第二次跑会卡在等码。
  const child = spawn(
    process.execPath,
    ['src/main.js', '--listen', `127.0.0.1:${PORT}`, '--pair'],
    {
      cwd: new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  return child;
}

/** 等某个正则出现在子进程输出里，返回匹配结果。 */
function waitFor(child, re, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`等 ${re} 超时，最后输出：${buf.slice(-400)}`));
    }, timeoutMs);
    const onData = (chunk) => {
      buf += chunk;
      const m = buf.match(re);
      if (m) {
        cleanup();
        resolve(m);
      }
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.off('data', onData);
      child.stderr.off('data', onData);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => {
      cleanup();
      reject(new Error(`网关提前退出（code=${code}）`));
    });
  });
}

async function postJson(path, body, token) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body ?? {}),
  });
  const json = await res.json();
  if (!res.ok || json.ok === false) {
    throw new Error(`${path} → ${res.status} ${JSON.stringify(json).slice(0, 300)}`);
  }
  return json.data ?? json;
}

const main = async () => {
  log(`启动网关：127.0.0.1:${PORT}`);
  const gw = startGateway();
  const kill = () => {
    try {
      gw.kill('SIGTERM');
    } catch {
      /* ignore */
    }
  };
  process.on('exit', kill);
  process.on('SIGINT', () => {
    kill();
    process.exit(130);
  });

  try {
    const [, code] = await waitFor(gw, /配对码 (\d{6})/);
    log(`拿到配对码 ${code}`);

    const paired = await postJson('/v1/pair', { code, deviceName: 'e2e-smoke' });
    const token = paired.token;
    if (!token) throw new Error('配对没返回 token');
    log(`配对成功，设备 ${paired.device?.id ?? '?'}`);

    // 等 DSH 握上手（网关会自己重连，这里给足冷启动时间）
    await waitFor(gw, /DSH 已连接/, 40_000);
    log('DSH 已连接');

    const created = await postJson('/v1/sessions', { cwd: process.cwd() }, token);
    const sessionId = created.sessionId;
    log(`建会话 ${sessionId}`);

    // SSE 先连上，再发消息，避免漏掉第一批 chunk
    const controller = new AbortController();
    const sse = await fetch(`${BASE}/v1/sessions/${sessionId}/stream`, {
      headers: { authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    if (!sse.ok) throw new Error(`SSE 连接失败：${sse.status}`);

    const events = [];
    const done = (async () => {
      const reader = sse.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done: finished } = await reader.read();
        if (finished) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const raw = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          // 网关的 SSE **不带 event: 行**，事件类型在 JSON 的 type 字段里。
          // 两种都兼容：有 event: 行就优先用它，否则退回 data.type。
          const headerName = raw.match(/^event:\s*(.+)$/m)?.[1]?.trim();
          const dataLine = raw.match(/^data:\s*(.+)$/m)?.[1] ?? '';
          let data = null;
          try {
            data = JSON.parse(dataLine);
          } catch {
            /* 忽略 `: ping` 心跳等非 JSON */
          }
          const name = headerName || data?.type || 'message';
          events.push({ name, data });
          if (name === 'turn_end') return data;
        }
      }
      return null;
    })();

    const submitted = await postJson(`/v1/sessions/${sessionId}/messages`, { text: TEXT }, token);
    log(`已提交 turn ${submitted.turnId ?? '?'}，等回包…`);

    const guarded = Promise.race([
      done,
      new Promise((_, rej) => setTimeout(() => rej(new Error(`${TIMEOUT_MS}ms 内没等到 turn_end`)), TIMEOUT_MS)),
    ]);
    const end = await guarded;
    controller.abort();

    const texts = events
      .filter((e) => e.name === 'text' || e.name === 'message')
      .map((e) => (typeof e.data === 'string' ? e.data : e.data?.text ?? ''))
      .filter(Boolean);
    const kinds = [...new Set(events.map((e) => e.name))];

    log('');
    log('收到事件类型：', kinds.join(', ') || '(无)');
    log('文本块数量：', texts.length);
    if (texts.length) log('拼起来：', JSON.stringify(texts.join('')).slice(0, 300));
    log('turn_end：', JSON.stringify(end).slice(0, 300));

    const chunked = events.some((e) => e.name === 'text');
    if (!chunked) {
      die('没收到任何 text 事件 —— 流式回包这条链没通');
    } else if (end?.ok === false) {
      // 失败时错误在 end.failure 里（hub 的形状），不在顶层
      const f = end.failure ?? {};
      die(`回合失败：${f.code ?? '?'} ${f.error ?? ''} ${f.hint ?? ''}`);
    } else {
      log('✅ 端到端通过：手机侧会看到的东西，这里都收到了');
    }
  } catch (e) {
    die(e?.message ?? String(e));
  } finally {
    kill();
  }
};

await main();
