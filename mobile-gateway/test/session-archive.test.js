import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSessionArchive } from '../src/session-archive.js';

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dshm-arch-')), 'archived-sessions.json');
}

test('归档 → 标记 → 取消归档，全程只写名单', () => {
  const file = tmpFile();
  const a = createSessionArchive({ file });
  assert.equal(a.has('sess-1'), false);
  assert.equal(a.archive('sess-1'), true);
  assert.equal(a.has('sess-1'), true);
  assert.deepEqual(a.list(), ['sess-1']);
  assert.equal(a.unarchive('sess-1'), true);
  assert.equal(a.has('sess-1'), false);
});

test('重启后归档名单还在（落盘）', () => {
  const file = tmpFile();
  createSessionArchive({ file }).archive('sess-keep');
  const again = createSessionArchive({ file });
  assert.equal(again.has('sess-keep'), true);
});

test('不合法的 id 不写入，返回 false', () => {
  const a = createSessionArchive({ file: tmpFile() });
  assert.equal(a.archive('../../etc/passwd'), false);
  assert.equal(a.archive(''), false);
  assert.deepEqual(a.list(), []);
});

test('重复归档 / 取消不存在的归档都算成功（幂等）', () => {
  const a = createSessionArchive({ file: tmpFile() });
  assert.equal(a.archive('s'), true);
  assert.equal(a.archive('s'), true);
  assert.equal(a.unarchive('nope'), true);
});

test('名单文件坏了：按空处理，不抛错', () => {
  const file = tmpFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{ not json', 'utf8');
  const a = createSessionArchive({ file });
  assert.equal(a.has('x'), false);
  assert.equal(a.archive('x'), true, '坏档不该阻止后续归档');
});

test('写盘失败要返回 false，并且不在内存里留下「假归档」', () => {
  const file = path.join(tmpFile(), 'nested', 'archived.json');
  // Windows 文件名里的 \0 会让 open 直接失败，用来稳定模拟写盘失败
  const bad = createSessionArchive({ file: `${file}\u0000bad` });
  assert.equal(bad.archive('s'), false);
  assert.equal(bad.has('s'), false);
});
