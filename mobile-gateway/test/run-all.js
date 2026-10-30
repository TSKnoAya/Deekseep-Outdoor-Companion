/**
 * 一次性跑完全部测试。
 *
 * 为什么不用 `node --test test/`：
 * ① 本仓库的开发沙箱禁止 spawn 子进程，而 `node --test` 的目录模式会为每个
 *    测试文件 fork 一个子进程（实测 `spawn EPERM`）。用 `--test` 显式给文件
 *    列表同样是 fork。所以这里用 **进程内** `run()`：一个进程跑完全部。
 * ② 这样跑完就是跑完了，不会有"某个文件静默没被执行"。
 *
 * 用法：
 *   node test/run-all.js          # 全跑
 *   node test/run-all.js --grep 审批   # 只跑名字里带"审批"的
 */

import { run } from 'node:test';
import { spec } from 'node:test/reporters';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import process from 'node:process';

const here = path.dirname(fileURLToPath(import.meta.url));

const FILES = [
  'acp-client.test.js',
  'announce.test.js',
  'cli.test.js',
  'devices.test.js',
  'errors-audio.test.js',
  'paths.test.js',
  'server.test.js',
];

const args = process.argv.slice(2);
const grepIdx = args.indexOf('--grep');
const grep = grepIdx >= 0 ? args[grepIdx + 1] : undefined;

const stream = run({
  files: FILES.map((f) => path.join(here, f)),
  concurrency: 1, // 串行：server 测试会起端口，并行没必要且更难读日志
  ...(grep ? { testNamePatterns: [grep] } : {}),
});

stream.compose(spec).pipe(process.stdout);

stream.on('end', () => {
  // 显式退出：server 测试里可能有未关闭的 keep-alive 连接
  setTimeout(() => process.exit(process.exitCode ?? 0), 100).unref?.();
});
