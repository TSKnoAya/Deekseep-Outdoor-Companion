/**
 * 启动参数与局域网地址探测的测试。
 *
 * 这组测试存在的理由：`main.js` 的报错文案里写过一个 `--listen` 开关，
 * 而代码从来没解析过 argv——用户照着提示敲，只会得到 `node: bad option`。
 * 「文案里出现的命令必须真能跑」这件事，只能靠测试钉住。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, usage, isLoopbackHost, lanAddresses } from '../src/cli.js';
import { resolveConfig, parseListen } from '../src/config.js';

test('--listen host:port 被解析出来', () => {
  assert.equal(parseArgs(['--listen', '0.0.0.0:8788']).listen, '0.0.0.0:8788');
});

test('--listen=host:port 这种等号写法也认', () => {
  assert.equal(parseArgs(['--listen=192.168.1.5:9000']).listen, '192.168.1.5:9000');
});

test('没给 --listen 时是 null，不是空串', () => {
  // null 与 '' 的区别很重要：main.js 用 `!== null` 判断要不要覆盖配置，
  // 如果这里返回空串，会把「没传参」误判成「传了个非法地址」。
  assert.equal(parseArgs([]).listen, null);
});

test('--help / -h 都能认出来', () => {
  assert.equal(parseArgs(['--help']).help, true);
  assert.equal(parseArgs(['-h']).help, true);
  assert.equal(parseArgs([]).help, false);
});

test('--pair 能认出来，且默认是 false', () => {
  // 配对过设备之后启动就不再自动打码，--pair 是唯一的重发入口。
  assert.equal(parseArgs(['--pair']).pair, true);
  assert.equal(parseArgs(['--listen', '0.0.0.0:8788', '--pair']).pair, true);
  assert.equal(parseArgs([]).pair, false);
});

test('不认识的参数不会让解析崩掉，也不会污染 listen', () => {
  const r = parseArgs(['--verbose', 'whatever', '--listen', '127.0.0.1:8788']);
  assert.equal(r.listen, '127.0.0.1:8788');
  assert.equal(parseArgs(['--nope']).listen, null);
});

test('--listen 后面没跟值时给空串（交给 parseListen 报错，而不是静默用默认）', () => {
  assert.equal(parseArgs(['--listen']).listen, '');
});

test('usage 里写的命令与真实能力一致', () => {
  const text = usage();
  assert.match(text, /--listen host:port/);
  assert.match(text, /0\.0\.0\.0:8788/);
  assert.match(text, /DSH_MOBILE_LISTEN/);
  assert.match(text, /--pair/);
});

test('--listen 的值能过 parseListen；非法值会被拦下', () => {
  assert.deepEqual(parseListen('0.0.0.0:8788'), { host: '0.0.0.0', port: 8788 });
  assert.throws(() => parseListen('nonsense'));
  assert.throws(() => parseListen('0.0.0.0:99999'));
});

test('命令行 --listen 会覆盖默认回环地址', () => {
  assert.equal(resolveConfig().listen, '127.0.0.1:8788');
  assert.equal(resolveConfig({ listen: '0.0.0.0:8788' }).listen, '0.0.0.0:8788');
});

test('回环地址判定：手机永远连不到的那三个', () => {
  assert.equal(isLoopbackHost('127.0.0.1'), true);
  assert.equal(isLoopbackHost('localhost'), true);
  assert.equal(isLoopbackHost('::1'), true);
  assert.equal(isLoopbackHost('0.0.0.0'), false);
  assert.equal(isLoopbackHost('192.168.1.247'), false);
});

test('lanAddresses 挑出可用的 IPv4，滤掉回环/APIPA/内部网卡', () => {
  const fake = {
    lo: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }],
    wifi: [
      { family: 'IPv4', internal: false, address: '192.168.1.247' },
      { family: 'IPv6', internal: false, address: 'fe80::1' },
    ],
    dead: [{ family: 'IPv4', internal: false, address: '169.254.10.10' }],
  };
  assert.deepEqual(lanAddresses(fake), ['192.168.1.247']);
});

test('lanAddresses 兼容 family 用数字 4 表示的老写法', () => {
  const fake = { eth: [{ family: 4, internal: false, address: '10.0.0.7' }] };
  assert.deepEqual(lanAddresses(fake), ['10.0.0.7']);
});

test('没有网卡时返回空数组，不抛错（启动横幅要能继续打配对码）', () => {
  assert.deepEqual(lanAddresses({}), []);
  assert.deepEqual(lanAddresses(null), []);
});
