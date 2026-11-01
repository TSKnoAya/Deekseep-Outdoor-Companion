/**
 * 手机端的「归档」名单：只在手机列表里隐藏，**不动任何会话文件**。
 *
 * 为什么不删文件：手机下拉列的是本机 DSH 能看到的所有会话，桌面端的也在里面；
 * 从手机删掉会连带影响电脑上的对话。归档只是给「我不想在手机上看到它」一个出口，
 * 在桌面端完全无感，也能随时恢复。
 *
 * 存储：`<stateDir>/archived-sessions.json`；写盘用临时文件 + rename，避免半截文件。
 */

import fs from 'node:fs';
import path from 'node:path';

/** 会话 id 只允许这些字符：我们只存字符串，但也不该把任意内容写进名单。 */
const VALID_ID = /^[A-Za-z0-9._:-]{1,200}$/;

export function createSessionArchive(options = {}) {
  const file = options.file ?? null;
  const log = options.log ?? (() => {});
  /** @type {Set<string>} */
  let ids = new Set();

  function load() {
    if (!file) return;
    try {
      const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(doc?.archived)) {
        ids = new Set(doc.archived.filter((x) => typeof x === 'string' && VALID_ID.test(x)));
      }
    } catch (e) {
      if (e?.code !== 'ENOENT') log(`归档名单读取失败（${e?.message ?? e}），按空处理`);
    }
  }

  function save() {
    if (!file) return false;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, archived: [...ids] }, null, 2), 'utf8');
      fs.renameSync(tmp, file);
      return true;
    } catch (e) {
      // 写不进去不该让归档动作「成功」——否则重启后又冒出来
      log(`归档名单写盘失败：${e?.message ?? e}`);
      return false;
    }
  }

  load();

  return {
    has(id) {
      return ids.has(String(id ?? ''));
    },
    list() {
      return [...ids];
    },
    /** @returns {boolean} 是否已成功写入名单（含重复归档）。 */
    archive(id) {
      const s = String(id ?? '');
      if (!VALID_ID.test(s)) return false;
      if (ids.has(s)) return true;
      ids.add(s);
      // 写盘失败要回滚内存：否则接口说失败、GET 里却已经隐藏，两边矛盾
      if (!save()) {
        ids.delete(s);
        return false;
      }
      return true;
    },
    unarchive(id) {
      const s = String(id ?? '');
      if (!ids.delete(s)) return true;
      if (!save()) {
        ids.add(s);
        return false;
      }
      return true;
    },
  };
}
