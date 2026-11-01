import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDshArchive } from '../src/dsh-archive.js';

function tmpWorkspace(ids = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshm-dsharch-'));
  const file = path.join(dir, 'workspace.json');
  fs.writeFileSync(file, JSON.stringify({ unit: {}, global: { archivedSessionIds: ids }, tables: {} }), 'utf8');
  return file;
}

test('读 DSH 的 global.archivedSessionIds', () => {
  const file = tmpWorkspace(['a', 'b']);
  const a = createDshArchive({ file });
  assert.equal(a.has('a'), true);
  assert.equal(a.has('b'), true);
  assert.equal(a.has('c'), false);
  assert.deepEqual(a.list().sort(), ['a', 'b']);
});

test('DSH 保存后自动生效（mtime/size 变了就重读，不用重启网关）', () => {
  const file = tmpWorkspace(['a']);
  const a = createDshArchive({ file });
  assert.equal(a.has('b'), false);

  fs.writeFileSync(file, JSON.stringify({ global: { archivedSessionIds: ['a', 'b'] } }), 'utf8');
  const future = new Date(Date.now() + 5000);
  fs.utimesSync(file, future, future);

  assert.equal(a.has('b'), true, '文件更新后应立即反映');
});

test('文件不存在：按空处理，不抛错', () => {
  const a = createDshArchive({ file: path.join(os.tmpdir(), 'definitely-missing-dshm', 'workspace.json') });
  assert.equal(a.has('x'), false);
  assert.deepEqual(a.list(), []);
});

test('文件坏掉：沿用上一次结果，不把列表清空', () => {
  const file = tmpWorkspace(['a']);
  const logs = [];
  const a = createDshArchive({ file, log: (m) => logs.push(m) });
  assert.equal(a.has('a'), true);

  fs.writeFileSync(file, '{ not json', 'utf8');
  const future = new Date(Date.now() + 5000);
  fs.utimesSync(file, future, future);

  assert.equal(a.has('a'), true, '坏档不该让状态突然变空');
  assert.ok(logs.some((m) => m.includes('读取 DSH 归档状态失败')));
});

test('非字符串/缺失字段都安全跳过', () => {
  const file = tmpWorkspace();
  fs.writeFileSync(file, JSON.stringify({ global: { archivedSessionIds: ['ok', 42, null] } }), 'utf8');
  const a = createDshArchive({ file });
  assert.deepEqual(a.list(), ['ok']);
});
