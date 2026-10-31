import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  buildPairPayload,
  parsePairPayload,
  qrMatrix,
  makePairQr,
  PAIR_SCHEME,
  PAIR_HOST,
} from '../src/pair-qr.js';

const CANON = { url: 'http://192.168.1.247:8788', code: '717842' };

test('载荷：地址 + 码 → dshmobile 链接，可原样解析回来', () => {
  const payload = buildPairPayload(CANON);
  assert.equal(
    payload,
    'dshmobile://pair?v=1&u=http%3A%2F%2F192.168.1.247%3A8788&c=717842',
  );
  assert.deepEqual(parsePairPayload(payload), CANON);
  assert.equal(new URL(payload).protocol, `${PAIR_SCHEME}:`);
  assert.equal(new URL(payload).host, PAIR_HOST);
});

test('载荷：拒绝非 http(s) 地址与非 6 位码', () => {
  assert.throws(() => buildPairPayload({ url: 'javascript:alert(1)', code: '123456' }), /http/);
  assert.throws(() => buildPairPayload({ url: 'file:///etc/passwd', code: '123456' }), /http/);
  assert.throws(() => buildPairPayload({ url: CANON.url, code: '12345' }), /6 位/);
  assert.throws(() => buildPairPayload({ url: CANON.url, code: 'abcdef' }), /6 位/);
});

test('解析：普通地址链接只给地址（码留给用户手输）', () => {
  assert.deepEqual(parsePairPayload('http://10.0.0.5:8788'), { url: 'http://10.0.0.5:8788', code: null });
  assert.deepEqual(parsePairPayload(' https://tail.example.ts.net:443/ '), {
    url: 'https://tail.example.ts.net:443/',
    code: null,
  });
});

test('解析：别的 scheme/host、缺字段、脏内容一律 null', () => {
  assert.equal(parsePairPayload(''), null);
  assert.equal(parsePairPayload('随便一段文字'), null);
  assert.equal(parsePairPayload('dshmobile://other?v=1&u=http%3A%2F%2F1.2.3.4%3A8788&c=123456'), null);
  assert.equal(parsePairPayload('dshmobile://pair?v=1&u=http%3A%2F%2F1.2.3.4%3A8788'), null);
  assert.equal(parsePairPayload('dshmobile://pair?v=1&c=123456'), null);
  assert.equal(parsePairPayload('dshmobile://pair?v=1&u=javascript%3Aalert(1)&c=123456'), null);
});

test('矩阵：M 级纠错、37×37、左上角有定位图案', () => {
  const { size, rows } = qrMatrix(buildPairPayload(CANON));
  assert.equal(size, 37);
  assert.equal(rows.length, 37);
  for (const row of rows) {
    assert.equal(row.length, 37);
    assert.match(row, /^[01]+$/);
  }
  // 标准定位图案：7×7 实心方块 + 一圈白边 + 3×3 黑心
  assert.equal(rows[0].slice(0, 7), '1111111');
  assert.equal(rows[6].slice(0, 7), '1111111');
  assert.equal(rows[0][7], '0');
  assert.equal(rows[7].slice(0, 7), '0000000');
  assert.equal(rows[1].slice(0, 7), '1000001');
  assert.equal(rows[2].slice(0, 7), '1011101');
  assert.equal(rows[3].slice(0, 7), '1011101');
});

test('矩阵：内容过长时报错，不生成扫不出来的码', () => {
  assert.throws(() => qrMatrix('x'.repeat(5000)), /二维码/);
});

test('矩阵：确定性，且与已验证可解码的样本一致', () => {
  // 该哈希是在 jsQR 1.4.0 里把这个矩阵渲染成像素并成功解码回同一载荷后钉住的。
  // 编码库/参数一改就会变——变了要重新验一遍「真能扫出来」再更新这里。
  const { rows } = qrMatrix(buildPairPayload(CANON));
  const hash = crypto.createHash('sha256').update(rows.join('\n')).digest('hex');
  assert.equal(hash, '8ad161ccfc0b021bb9eb5ce609be1d882d625cd9c83e2d04d8fe17cef3303e12');

  const again = qrMatrix(buildPairPayload(CANON));
  assert.deepEqual(again, qrMatrix(buildPairPayload(CANON)));
});

test('makePairQr：载荷与矩阵同源（码变了矩阵就变）', () => {
  const a = makePairQr(CANON);
  const b = makePairQr({ ...CANON, code: '000001' });
  assert.equal(parsePairPayload(a.payload).code, '717842');
  assert.equal(parsePairPayload(b.payload).code, '000001');
  assert.notDeepEqual(a.qr.rows, b.qr.rows);
});
