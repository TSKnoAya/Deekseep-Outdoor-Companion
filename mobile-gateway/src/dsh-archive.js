/**
 * 只读 DSH 的「归档」状态：`~/.dsh/storages/workspace.json` → `global.archivedSessionIds`。
 *
 * 为什么只读：
 * 归档是 DSH 桌面端（workspaceController）的能力，状态在它内存里、落盘到上面那个文件。
 * 网关是**另一个进程**，直接改这个文件会与 DSH 的无锁写入打架（BOUNDARIES §8），
 * 所以手机端只跟随 DSH 的结果：DSH 里归档/取消，手机列表随之变化。
 *
 * 读文件是安全的；用 mtime+size 做缓存，DSH 每次保存后自动生效，不用重启网关。
 */

import fs from 'node:fs';

export function createDshArchive(options = {}) {
  const file = options.file ?? null;
  const log = options.log ?? (() => {});
  let cache = { mtimeMs: -1, size: -1, ids: new Set() };

  function refresh() {
    if (!file) return;
    try {
      const st = fs.statSync(file);
      if (st.mtimeMs === cache.mtimeMs && st.size === cache.size) return;
      const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
      const list = doc?.global?.archivedSessionIds;
      cache = {
        mtimeMs: st.mtimeMs,
        size: st.size,
        ids: new Set(Array.isArray(list) ? list.filter((x) => typeof x === 'string') : []),
      };
    } catch (e) {
      // 文件不存在（还没归档过）/正在被 DSH 写：保留上一次结果，不中断列表
      if (e?.code !== 'ENOENT') log(`读取 DSH 归档状态失败（${e?.message ?? e}），沿用上一次结果`);
    }
  }

  refresh();

  return {
    refresh,
    has(id) {
      refresh();
      return cache.ids.has(String(id ?? ''));
    },
    list() {
      refresh();
      return [...cache.ids];
    },
  };
}
