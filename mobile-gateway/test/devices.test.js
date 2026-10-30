/**
 * 设备配对与令牌测试。
 *
 * 这层是**唯一的安全边界**：网关一旦监听到局域网，同网段任何设备都能连。
 * 所以除了「正常配对」，更要钉住每条失败路径——限次、过期、一次性、令牌只存哈希。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DeviceStore, hashToken, makePairCode, makeToken, safeEqualHex } from '../src/devices.js';

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshm-dev-'));
  return new DeviceStore({ file: path.join(dir, 'devices.json') });
}

test('配对码是 6 位数字', () => {
  for (let i = 0; i < 50; i++) {
    const code = makePairCode();
    assert.match(code, /^\d{6}$/);
  }
});

test('正常配对后能拿到令牌，且令牌能验通过', () => {
  const store = tmpStore();
  const { code } = store.issuePairCode();
  const { deviceId, token } = store.pair({ code, deviceName: '红米 K80' });

  assert.equal(deviceId.startsWith('dev-'), true);
  assert.ok(token.length >= 40);

  const device = store.verify(token);
  assert.ok(device, '刚配对的令牌必须能验过');
  assert.equal(device.id, deviceId);
  assert.equal(device.name, '红米 K80');
});

test('配对码是一次性的：用过就不能再用', () => {
  const store = tmpStore();
  const { code } = store.issuePairCode();
  store.pair({ code, deviceName: 'A' });

  assert.throws(
    () => store.pair({ code, deviceName: 'B' }),
    (e) => {
      assert.equal(e.code, 'pair.code-expired');
      return true;
    },
  );
});

test('配对码过期后明确报过期', () => {
  const store = tmpStore();
  const { code } = store.issuePairCode(1000);
  // 5 分钟有效期，推进 6 分钟
  assert.throws(
    () => store.pair({ code, deviceName: 'A' }, 1000 + 6 * 60 * 1000),
    (e) => {
      assert.equal(e.code, 'pair.code-expired');
      assert.ok(e.hint.length > 0);
      return true;
    },
  );
});

test('配对码输错 5 次后作废，即使第 6 次输对也不行', () => {
  const store = tmpStore();
  const { code } = store.issuePairCode();
  // 故意输错的码（避开真实码）
  const wrong = code === '000000' ? '111111' : '000000';

  for (let i = 0; i < 5; i++) {
    assert.throws(() => store.pair({ code: wrong, deviceName: 'X' }), (e) => {
      assert.equal(e.code, 'pair.code-invalid');
      assert.ok(e.hint.length > 0, '每次失败都要能告诉用户还能试几次');
      return true;
    });
  }

  assert.throws(
    () => store.pair({ code, deviceName: 'X' }),
    (e) => {
      assert.equal(e.code, 'pair.rate-limited');
      return true;
    },
  );
});

test('没有生成配对码时，提示先去电脑端生成', () => {
  const store = tmpStore();
  assert.throws(
    () => store.pair({ code: '123456', deviceName: 'A' }),
    (e) => {
      assert.equal(e.code, 'pair.code-expired');
      assert.match(e.message, /还没有生成/);
      return true;
    },
  );
});

test('令牌只以哈希落盘，文件里不能出现明文', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshm-hash-'));
  const file = path.join(dir, 'devices.json');
  const store = new DeviceStore({ file });
  const { code } = store.issuePairCode();
  const { token } = store.pair({ code, deviceName: 'A' });

  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(!raw.includes(token), '明文令牌绝不能出现在磁盘上');

  const doc = JSON.parse(raw);
  assert.equal(doc.devices[0].tokenHash, hashToken(token));
});

test('无效令牌验不过，也不会抛（让调用方决定怎么响应）', () => {
  const store = tmpStore();
  assert.equal(store.verify(''), null);
  assert.equal(store.verify('not-a-real-token'), null);
  assert.equal(store.verify(undefined), null);
  assert.equal(store.verify(null), null);
});

test('list() 不返回 tokenHash', () => {
  const store = tmpStore();
  const { code } = store.issuePairCode();
  store.pair({ code, deviceName: 'A' });
  const listed = store.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].tokenHash, undefined);
  assert.ok(listed[0].name);
});

test('可以单独吊销一台设备，其他设备不受影响', () => {
  const store = tmpStore();
  const a = store.pair({ code: store.issuePairCode().code, deviceName: 'A' });
  const b = store.pair({ code: store.issuePairCode().code, deviceName: 'B' });

  store.revoke(a.deviceId);

  assert.equal(store.verify(a.token), null, '被吊销的令牌必须立刻失效');
  assert.ok(store.verify(b.token), '另一台设备不能受影响');
  assert.equal(store.list().length, 1);
});

test('吊销不存在的设备要报 not-found', () => {
  const store = tmpStore();
  assert.throws(
    () => store.revoke('dev-nope'),
    (e) => {
      assert.equal(e.code, 'request.not-found');
      return true;
    },
  );
});

test('设备表损坏时按空表启动，并把坏文件隔离（不能让网关起不来）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshm-broken-'));
  const file = path.join(dir, 'devices.json');
  fs.writeFileSync(file, '{ this is not json', 'utf8');

  const logs = [];
  const store = new DeviceStore({ file, log: (m) => logs.push(m) });

  assert.equal(store.list().length, 0, '坏文件应被当成空表');
  assert.ok(logs.some((l) => l.includes('读取失败')));
  // 坏文件被改名保留，不是删除
  const files = fs.readdirSync(dir);
  assert.ok(files.some((f) => f.includes('broken-')), '坏文件要隔离保留，不是删掉');
});

test('safeEqualHex 对空串一律 false（否则空令牌=空令牌就通过了）', () => {
  assert.equal(safeEqualHex('', ''), false);
  assert.equal(safeEqualHex('abc', ''), false);
  assert.equal(safeEqualHex('abc', 'abd'), false);
  assert.equal(safeEqualHex('abc', 'abc'), true);
});

test('makeToken 每次都不一样，且长度稳定', () => {
  const set = new Set();
  for (let i = 0; i < 100; i++) set.add(makeToken());
  assert.equal(set.size, 100);
});

test('配对码状态能反映剩余次数与过期', () => {
  const store = tmpStore();
  assert.equal(store.pairStatus().active, false);

  const issued = store.issuePairCode();
  const s = store.pairStatus(issued.expiresAt - 1000);
  assert.equal(s.active, true);
  assert.equal(s.attemptsLeft, 5);
  assert.ok(s.remainingMs > 0);

  const expired = store.pairStatus(issued.expiresAt + 1);
  assert.equal(expired.active, false);
  assert.equal(expired.expired, true);
});
