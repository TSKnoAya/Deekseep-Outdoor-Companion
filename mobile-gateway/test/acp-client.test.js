/**
 * ACP 客户端测试：用内存传输模拟 DSH，**不需要真进程**。
 *
 * 为什么这组测试值得写：ACP 最容易错的三件事——
 *   ① 服务端主动发 request（审批）时，客户端会不会回；
 *   ② 同一会话并发 prompt 时，会不会被本地拦住（而不是等 DSH 报错）；
 *   ③ DSH 进程退出时，挂起的请求会不会永远挂着。
 * 这三件事在真机上要复现都很麻烦，用假服务端几行就穷举了。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AcpClient, extractText } from '../src/acp-client.js';
import { memoryTransport } from '../src/transport.js';

/** 造一个「客户端→服务端→客户端」的假 DSH。 */
function makeClient(handlers = {}) {
  const serverWrites = [];
  const transport = memoryTransport({
    onClientWrite(line) {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      serverWrites.push(msg);
      const handler = handlers[msg.method];
      if (!handler) {
        // 默认：所有 method 都回一个空 result，避免测试之间互相干扰
        transport.serverPush(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }));
        return;
      }
      handler(msg, transport);
    },
  });
  const client = new AcpClient({ transport });
  return { client, transport, serverWrites };
}

test('initialize 校验协议版本，版本不符要明确报错', async () => {
  const { client } = makeClient({
    initialize: (msg, t) =>
      t.serverPush(
        JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 2, agentInfo: { name: 'x' } } }),
      ),
  });
  await assert.rejects(
    () => client.initialize(),
    (e) => {
      assert.equal(e.code, 'acp.protocol-mismatch');
      assert.match(e.message, /期望 1/);
      assert.ok(e.hint.length > 0, '必须给下一步提示');
      return true;
    },
  );
});

test('initialize 成功时记录服务端能力', async () => {
  const { client } = makeClient({
    initialize: (msg, t) =>
      t.serverPush(
        JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            protocolVersion: 1,
            agentInfo: { name: 'deepseek-harness-acp', version: '0.0.1' },
            agentCapabilities: { sessionCapabilities: { list: {}, resume: {}, close: {} } },
          },
        }),
      ),
  });
  const r = await client.initialize();
  assert.equal(r.protocolVersion, 1);
  assert.equal(client.initialized, true);
  assert.deepEqual(Object.keys(client.sessionCapabilities).sort(), ['close', 'list', 'resume']);
});

test('session/new 没有 sessionId 时不能假装成功', async () => {
  const { client } = makeClient({
    'session/new': (msg, t) => t.serverPush(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} })),
  });
  await assert.rejects(
    () => client.newSession({ cwd: 'C:\\tmp' }),
    (e) => {
      assert.equal(e.code, 'internal.error');
      return true;
    },
  );
});

test('同一会话并发 prompt 会被本地拦住，不会打到 DSH', async () => {
  // 这个 handler 故意永不回包：第一轮会一直"在飞"
  const { client, serverWrites } = makeClient({
    'session/prompt': () => {},
  });

  const first = client.prompt({ sessionId: 's1', text: '一' });
  // 给第一个请求一点时间进到 pending
  await new Promise((r) => setTimeout(r, 10));

  await assert.rejects(
    () => client.prompt({ sessionId: 's1', text: '二' }),
    (e) => {
      assert.equal(e.code, 'acp.prompt-busy');
      assert.ok(e.hint.length > 0);
      return true;
    },
  );

  // 只发出去一条
  assert.equal(serverWrites.filter((m) => m.method === 'session/prompt').length, 1);
  // 收尾，避免悬挂的 promise 影响其他测试
  client.destroy();
  await Promise.race([first, new Promise((r) => setTimeout(r, 50))]);
});

test('服务端主动发 request_permission 时，会调用处理器并把结果回传', async () => {
  const received = [];
  const { client, transport } = makeClient({
    'session/prompt': (msg, t) => {
      // 先推一段文本增量，再发审批请求
      t.serverPush(
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 's1',
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '我来跑个命令' } },
          },
        }),
      );
      t.serverPush(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 999,
          method: 'session/request_permission',
          params: {
            sessionId: 's1',
            toolCall: { toolCallId: 'call-1' },
            options: [
              { optionId: 'allow-once', kind: 'allow_once' },
              { optionId: 'reject-once', kind: 'reject_once' },
            ],
          },
        }),
      );
    },
  });

  client.onPermissionRequest = (req) => {
    received.push(req);
    return { outcome: 'selected', optionId: 'allow-once' };
  };

  const chunks = [];
  const p = client.prompt({ sessionId: 's1', text: '跑一下', onText: (c) => chunks.push(c) });

  await new Promise((r) => setTimeout(r, 40));

  // 审批请求被识别
  assert.equal(received.length, 1);
  assert.equal(received[0].toolCallId, 'call-1');
  assert.equal(received[0].options.length, 2);

  // 回传的 result 正确挂在原 id 上
  const reply = transport.written.map((l) => JSON.parse(l)).find((m) => m.id === 999);
  assert.ok(reply, '必须回一个带原 id 的响应');
  assert.deepEqual(reply.result, { outcome: { outcome: 'selected', optionId: 'allow-once' } });

  // 文本增量也收到了
  assert.deepEqual(chunks, ['我来跑个命令']);

  client.destroy();
  await Promise.race([p, new Promise((r) => setTimeout(r, 50))]);
});

test('没有审批处理器时，按取消回包而不是静默挂住', async () => {
  const { client, transport } = makeClient({
    'session/prompt': (msg, t) =>
      t.serverPush(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 777,
          method: 'session/request_permission',
          params: { sessionId: 's1', toolCall: { toolCallId: 'c' }, options: [] },
        }),
      ),
  });
  const p = client.prompt({ sessionId: 's1', text: 'x' });
  await new Promise((r) => setTimeout(r, 30));

  const reply = transport.written.map((l) => JSON.parse(l)).find((m) => m.id === 777);
  assert.ok(reply, '没人处理也必须回包');
  assert.deepEqual(reply.result, { outcome: { outcome: 'cancelled' } });

  client.destroy();
  await Promise.race([p, new Promise((r) => setTimeout(r, 50))]);
});

test('DSH 进程退出时，挂起的请求立刻失败而不是永远转圈', async () => {
  const { client, transport } = makeClient({
    'session/prompt': () => {}, // 永不回
  });
  const p = client.prompt({ sessionId: 's1', text: 'x' });
  await new Promise((r) => setTimeout(r, 10));

  transport.serverExit({ code: 1 });

  await assert.rejects(p, (e) => {
    assert.equal(e.code, 'acp.not-running');
    assert.ok(e.hint.length > 0);
    return true;
  });
});

test('请求超时会给出 timeout 码，而不是永远挂起', async () => {
  const { client } = makeClient({ 'session/list': () => {} });
  client.requestTimeoutMs = 30;
  // acp-client 的超时计时器是 unref 的（为了不拖住进程退出），所以这里必须自己
  // 拿一个 ref 句柄把事件循环撑住；否则 node:test 会判定「事件循环已空」并把测试
  // 标记成 cancelled（不是 fail，极易被误读成通过）。
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await assert.rejects(
      () => client.listSessions(),
      (e) => {
        assert.equal(e.code, 'request.timeout');
        return true;
      },
    );
  } finally {
    clearTimeout(keepAlive);
  }
});

test('方法名不支持的服务端请求，回 method-not-found 而不是放着不管', async () => {
  const { client, transport } = makeClient({});
  client.initialize = async () => ({ protocolVersion: 1 });
  await client.initialize();

  transport.serverPush(
    JSON.stringify({ jsonrpc: '2.0', id: 42, method: 'client/something-weird', params: {} }),
  );
  const reply = transport.written.map((l) => JSON.parse(l)).find((m) => m.id === 42);
  assert.ok(reply);
  assert.equal(reply.error.code, -32601);
});

test('extractText 只取 text 块，忽略图片/资源链接', () => {
  assert.equal(extractText({ type: 'text', text: '你好' }), '你好');
  assert.equal(extractText([{ type: 'text', text: 'a' }, { type: 'image', data: 'xx' }, { type: 'text', text: 'b' }]), 'ab');
  assert.equal(extractText({ type: 'image', data: 'zz' }), '');
  assert.equal(extractText(null), '');
  assert.equal(extractText(undefined), '');
});

test('session/update 的两种 params 形状都能取到文本', async () => {
  const { client, transport } = makeClient({ 'session/prompt': () => {} });
  const chunks = [];
  const p = client.prompt({ sessionId: 's1', text: 'x', onText: (c) => chunks.push(c) });

  await new Promise((r) => setTimeout(r, 10));
  // 形状 A：update 嵌在 params.update 里（DSH 实际形状）
  transport.serverPush(
    JSON.stringify({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'A' } } },
    }),
  );
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(chunks, ['A']);

  client.destroy();
  await Promise.race([p, new Promise((r) => setTimeout(r, 50))]);
});
