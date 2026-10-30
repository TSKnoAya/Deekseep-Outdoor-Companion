/**
 * 错误契约 + 音频校验测试。
 *
 * 两组都是「契约级」的：错误码被 App 硬编码用来判断该显示哪个引导页，
 * WAV 校验错了则模型会静默转出乱码（最难受的一类失败）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CODES, fail, toFailure, ok, statusFor } from '../src/errors.js';
import { parseWav, pcm16ToFloat32, MAX_DURATION_SECONDS } from '../src/voice/asr-sherpa.js';
import { extractPcm, wrapWav } from '../src/voice/tts-volcengine.js';

// ── 错误契约 ──────────────────────────────────────────────────────────────

test('每个 CODES 都能造出带 code/error/hint 的失败对象', () => {
  for (const [name, code] of Object.entries(CODES)) {
    const f = toFailure(fail(code, `测试 ${name}`));
    assert.equal(f.ok, false);
    assert.equal(f.code, code);
    assert.ok(f.error.length > 0, `${name} 的 error 不能为空`);
    assert.ok(f.hint.length > 0, `${name} 必须有下一步提示`);
  }
});

test('未知异常收敛成 internal.error，但保留原始 message', () => {
  const f = toFailure(new Error('数据库炸了'));
  assert.equal(f.code, CODES.INTERNAL);
  assert.equal(f.error, '数据库炸了', '不能把原始信息吞掉，否则开发者无从下手');
  assert.ok(f.hint.length > 0);
});

test('未知异常带栈信息（截断）便于排查', () => {
  const f = toFailure(new Error('x'));
  assert.ok(f.details?.stack);
  assert.ok(f.details.stack.split('\n').length <= 4);
});

test('结构化错误不会被当成内部错误', () => {
  const f = toFailure(fail(CODES.BAD_REQUEST, '参数不对'));
  assert.equal(f.code, CODES.BAD_REQUEST);
  assert.equal(f.details, undefined);
});

test('自定义 hint 会覆盖默认提示', () => {
  const f = toFailure(fail(CODES.BAD_REQUEST, 'x', { hint: '照这个改' }));
  assert.equal(f.hint, '照这个改');
});

test('状态码映射符合直觉', () => {
  assert.equal(statusFor(CODES.BAD_REQUEST), 400);
  assert.equal(statusFor(CODES.UNAUTHORIZED), 401);
  assert.equal(statusFor(CODES.FORBIDDEN), 403);
  assert.equal(statusFor(CODES.NOT_FOUND), 404);
  assert.equal(statusFor(CODES.ACP_PROMPT_BUSY), 409);
  assert.equal(statusFor(CODES.ASR_NOT_CONFIGURED), 503);
  assert.equal(statusFor(CODES.TTS_PROVIDER_NOT_CONFIGURED), 503);
  assert.equal(statusFor(CODES.INTERNAL), 500);
  assert.equal(statusFor(CODES.TIMEOUT), 504);
});

test('ok() 的 ok 永远是 true', () => {
  assert.equal(ok({ a: 1 }).ok, true);
  assert.equal(ok({}).ok, true);
});

// ── WAV 校验 ──────────────────────────────────────────────────────────────

/** 造一个合法的 16kHz 单声道 PCM16 WAV。 */
function makeWav({ seconds = 0.1, sampleRate = 16000, channels = 1, bits = 16 } = {}) {
  const frames = Math.round(sampleRate * seconds);
  const dataLen = frames * channels * (bits / 8);
  const buf = Buffer.alloc(44 + dataLen);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * channels * (bits / 8), 28);
  buf.writeUInt16LE(channels * (bits / 8), 32);
  buf.writeUInt16LE(bits, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataLen, 40);
  return buf;
}

test('合法 WAV 能解析出正确参数与时长', () => {
  const info = parseWav(makeWav({ seconds: 0.5 }));
  assert.equal(info.sampleRate, 16000);
  assert.equal(info.channels, 1);
  assert.equal(info.bitsPerSample, 16);
  assert.ok(Math.abs(info.durationSeconds - 0.5) < 0.01);
});

test('采样率不是 16kHz 时明确拒绝（模型不会报错，只会转出乱码）', () => {
  assert.throws(
    () => parseWav(makeWav({ sampleRate: 44100 })),
    (e) => {
      assert.equal(e.code, CODES.AUDIO_INVALID);
      assert.match(e.message, /16000|16kHz/);
      assert.ok(e.hint.length > 0);
      return true;
    },
  );
});

test('双声道被拒绝', () => {
  assert.throws(
    () => parseWav(makeWav({ channels: 2 })),
    (e) => {
      assert.equal(e.code, CODES.AUDIO_INVALID);
      assert.match(e.message, /单声道/);
      return true;
    },
  );
});

test('8-bit 被拒绝', () => {
  assert.throws(
    () => parseWav(makeWav({ bits: 8 })),
    (e) => {
      assert.equal(e.code, CODES.AUDIO_INVALID);
      assert.match(e.message, /16-bit/);
      return true;
    },
  );
});

test('不是 WAV 的字节被拒绝', () => {
  assert.throws(
    () => parseWav(Buffer.from('not a wav at all, just text')),
    (e) => {
      assert.equal(e.code, CODES.AUDIO_INVALID);
      return true;
    },
  );
});

test('太短的字节被拒绝', () => {
  assert.throws(() => parseWav(Buffer.alloc(10)), (e) => {
    assert.equal(e.code, CODES.AUDIO_INVALID);
    return true;
  });
});

test('超长录音报 too-large 并说清上限', () => {
  assert.throws(
    () => parseWav(makeWav({ seconds: MAX_DURATION_SECONDS + 1 })),
    (e) => {
      assert.equal(e.code, CODES.AUDIO_TOO_LARGE);
      assert.match(e.message, new RegExp(String(MAX_DURATION_SECONDS)));
      return true;
    },
  );
});

test('WAV 里夹带 LIST 块也能正确找到 data（真实录音器会这样）', () => {
  const base = makeWav({ seconds: 0.1 });
  // 必须是**偶数**长度，这样才不用补填充字节——填充规则由下一个用例单独验证。
  // （上一版写的是 'INFOsome-metadata'，实际 17 字节是奇数，属于测试造错。）
  const listBody = Buffer.from('INFOsome-metadata2', 'ascii'); // 18 字节
  assert.equal(listBody.length % 2, 0, '这个用例要求偶数长度，否则会引入填充字节');
  const list = Buffer.alloc(8 + listBody.length);
  list.write('LIST', 0, 'ascii');
  list.writeUInt32LE(listBody.length, 4);
  listBody.copy(list, 8);

  // base 布局：RIFF(12) + fmt块(8+16=24，止于 36) + data块头(8) + PCM
  // 插入点必须在 fmt 之后、data 头之前，即偏移 36
  const merged = Buffer.concat([base.subarray(0, 36), list, base.subarray(36)]);
  merged.writeUInt32LE(merged.length - 8, 4);

  const info = parseWav(merged);
  assert.ok(info.dataLength > 0);
  assert.ok(Math.abs(info.durationSeconds - 0.1) < 0.01);
});

test('奇数长度的块后面那个填充字节会被正确跳过', () => {
  const base = makeWav({ seconds: 0.1 });
  const listBody = Buffer.from('ODD', 'ascii'); // 3 字节，奇数
  const list = Buffer.alloc(8 + listBody.length + 1); // +1 填充字节
  list.write('LIST', 0, 'ascii');
  list.writeUInt32LE(listBody.length, 4);
  listBody.copy(list, 8);
  list[8 + listBody.length] = 0; // 规范要求的填充

  const merged = Buffer.concat([base.subarray(0, 36), list, base.subarray(36)]);
  merged.writeUInt32LE(merged.length - 8, 4);

  const info = parseWav(merged);
  assert.ok(Math.abs(info.durationSeconds - 0.1) < 0.01, '填充字节没跳过会导致解析错位');
});

test('pcm16ToFloat32 归一化到 [-1,1]', () => {
  const pcm = Buffer.alloc(6);
  pcm.writeInt16LE(0, 0);
  pcm.writeInt16LE(16384, 2);
  pcm.writeInt16LE(-32768, 4);
  const f = pcm16ToFloat32(pcm);
  assert.equal(f.length, 3);
  assert.equal(f[0], 0);
  assert.ok(Math.abs(f[1] - 0.5) < 0.001);
  assert.equal(f[2], -1);
});

// ── 火山 PCM 提取（尚未接实现，但逻辑先钉住）──────────────────────────────

test('extractPcm：多行 base64 分片能拼起来', () => {
  const pcm = Buffer.alloc(100);
  for (let i = 0; i < 100; i++) pcm[i] = i & 0xff;
  // 模拟流式 WAV 头（长度字段是 0xFFFFFFFF）+ data
  const fakeHeader = Buffer.alloc(44, 0xab);
  fakeHeader.write('RIFF', 0, 'ascii');
  fakeHeader.writeUInt32LE(0xffffffff, 4);
  fakeHeader.write('WAVE', 8, 'ascii');
  fakeHeader.write('data', 36, 'ascii');
  const payload = Buffer.concat([fakeHeader, pcm]);

  const half = Math.floor(payload.length / 2);
  const line1 = JSON.stringify({ code: 0, data: payload.subarray(0, half).toString('base64') });
  const line2 = JSON.stringify({ code: 0, data: payload.subarray(half).toString('base64') });
  const line3 = JSON.stringify({ code: 20000000, data: null }); // 结束帧

  const got = extractPcm(`${line1}\n${line2}\n${line3}`);
  assert.deepEqual(got, pcm, '必须跳过流式头，只留 PCM');
});

test('extractPcm：错误码要抛出来，不能当成空音频', () => {
  assert.throws(
    () => extractPcm(JSON.stringify({ code: 55000000, message: 'resource ID mismatched' })),
    (e) => {
      assert.equal(e.code, CODES.TTS_FAILED);
      assert.match(e.message, /55000000/);
      return true;
    },
  );
});

test('extractPcm：全是垃圾行时返回空 buffer 而不是崩', () => {
  assert.equal(extractPcm('not json\n\n{"foo":1}').length, 0);
  assert.equal(extractPcm('').length, 0);
});

test('wrapWav 产出的头能被 parseWav 读回来（自洽性）', () => {
  const pcm = Buffer.alloc(3200 * 2); // 0.2 秒 @16k
  const wav = wrapWav(pcm, 16000);
  assert.equal(wav.length, 44 + pcm.length);
  const info = parseWav(wav);
  assert.ok(Math.abs(info.durationSeconds - 0.2) < 0.01);
});
