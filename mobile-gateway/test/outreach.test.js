import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createOutreachStore } from '../src/outreach.js';

/** 极简内存 fs：够覆盖"读文件 + 写文件 + mkdir"。 */
function memFs(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    readFileSync(p) {
      if (!map.has(p)) {
        const e = new Error('ENOENT');
        e.code = 'ENOENT';
        throw e;
      }
      return map.get(p);
    },
    writeFileSync(p, v) {
      map.set(p, String(v));
    },
    mkdirSync() {},
  };
}

const HOME = 'C:\\Users\\bob\\.dsh';
const FILE = path.join(HOME, 'mobile-gateway', 'outreach.json');
const CHAR = path.join(HOME, 'surfcore', 'characters', 'char-1');

function surf(purpose) {
  return memFs({
    [path.join(HOME, 'surfcore', 'characters', 'current.json')]: JSON.stringify({ id: 'char-1' }),
    [path.join(CHAR, 'purpose-outreach.json')]: JSON.stringify(purpose),
  });
}

test('入队 / 未读 / 确认后清空', () => {
  const fsLike = memFs();
  const s = createOutreachStore({ file: FILE, fsLike });
  s.append({ text: '在吗？', at: 1000, source: 'test' });
  s.append({ text: '   ', at: 1001, source: 'test' }); // 空白不入队
  const list = s.pending();
  assert.equal(list.length, 1);
  assert.equal(list[0].text, '在吗？');
  assert.deepEqual(s.ack([list[0].id]), { removed: 1, remaining: 0 });
  assert.equal(s.pending().length, 0);
});

test('每次都 sync 但同一条只说一次（lastSentAt 没变就不重复）', () => {
  const fsLike = surf({ lastText: '今天下雨了', lastSentAt: 5000 });
  const s = createOutreachStore({ file: FILE, dshHome: HOME, fsLike });
  assert.equal(s.pending().length, 1);
  assert.equal(s.pending().length, 1, '同一条不能每次打开都补一遍');
  assert.equal(s.pending()[0].source, 'surfcore-purpose');
});

test('SurfCore 又主动说了新的 → 再入队一条', () => {
  const fsLike = surf({ lastText: '第一句', lastSentAt: 5000 });
  const s = createOutreachStore({ file: FILE, dshHome: HOME, fsLike });
  assert.equal(s.pending().length, 1);
  // 模拟 SurfCore 更新
  fsLike.map.set(
    path.join(CHAR, 'purpose-outreach.json'),
    JSON.stringify({ lastText: '第二句', lastSentAt: 6000 }),
  );
  const list = s.pending();
  assert.equal(list.length, 2);
  assert.equal(list[1].text, '第二句');
});

test('lastText 为空（只是 tick，没真说话）不入队', () => {
  const fsLike = surf({ lastText: '', lastSentAt: 9000 });
  const s = createOutreachStore({ file: FILE, dshHome: HOME, fsLike });
  assert.equal(s.pending().length, 0);
});

test('没有 current.json（老布局/没建角色）时安静跳过', () => {
  const fsLike = memFs();
  const s = createOutreachStore({ file: FILE, dshHome: HOME, fsLike });
  assert.equal(s.pending().length, 0);
});

test('落盘后重建实例，未读还在（不能因为重启网关就丢）', () => {
  const fsLike = memFs();
  const s1 = createOutreachStore({ file: FILE, fsLike });
  s1.append({ text: '留着', at: 1, source: 'test' });
  const s2 = createOutreachStore({ file: FILE, fsLike });
  assert.equal(s2.pending().length, 1);
  assert.equal(s2.pending()[0].text, '留着');
});

test('最多留 50 条（防止长期堆积）', () => {
  const fsLike = memFs();
  const s = createOutreachStore({ file: FILE, fsLike });
  for (let i = 0; i < 60; i += 1) s.append({ text: `第${i}条`, at: i, source: 'test' });
  assert.equal(s.pending().length, 50);
  assert.equal(s.pending()[49].text, '第59条');
});
