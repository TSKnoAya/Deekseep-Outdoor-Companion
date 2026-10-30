/**
 * DSH 安装位置探测的测试。
 *
 * 为什么值得写：这一层的目的就是「别人电脑上也能跑」，那就一定要能证明
 * 「装在 C 盘也能认出来」「认不出来时说清楚找过哪」。真实磁盘没法测这些，
 * 所以 fsLike 是注入的。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  DSH_EXE_NAME,
  candidateDirs,
  cliPathFor,
  sherpaPathFor,
  detectInstall,
  resolveDshPaths,
  notFoundHint,
  isInsideAsar,
} from '../src/paths.js';

/** 造一个只认识指定路径的假文件系统。 */
function fakeFs(existing) {
  const set = new Set(existing.map((p) => path.win32.normalize(p)));
  return {
    existsSync: (p) => set.has(path.win32.normalize(p)),
    readdirSync: () => [],
  };
}

const ENV = {
  LOCALAPPDATA: 'C:\\Users\\bob\\AppData\\Local',
  APPDATA: 'C:\\Users\\bob\\AppData\\Roaming',
  PROGRAMFILES: 'C:\\Program Files',
  'PROGRAMFILES(X86)': 'C:\\Program Files (x86)',
  USERPROFILE: 'C:\\Users\\bob',
};

test('cli/sherpa 路径按 Electron 打包结构拼出来', () => {
  const dir = 'C:\\Program Files\\DeepSeek Harness';
  assert.equal(
    cliPathFor(dir),
    path.win32.join(
      dir,
      'resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js',
    ),
  );
  assert.equal(
    sherpaPathFor(dir),
    path.win32.join(
      dir,
      'resources/app.asar.unpacked/dsh/node_modules/sherpa-onnx-win-x64/sherpa-onnx.node',
    ),
  );
});

test('候选目录里优先是显式指定的那个', () => {
  const dirs = candidateDirs({ ...ENV, DSH_DIR: 'D:\\my-dsh' });
  assert.equal(dirs[0], 'D:\\my-dsh');
});

test('候选目录含各平台默认安装位置（别人的机器多半在 LOCALAPPDATA）', () => {
  const dirs = candidateDirs(ENV);
  assert.ok(dirs.includes('C:\\Users\\bob\\AppData\\Local\\Programs\\DeepSeek Harness'));
  assert.ok(dirs.includes('C:\\Program Files\\DeepSeek Harness'));
});

test('装在 LOCALAPPDATA\\Programs 下也能探测到', () => {
  const dir = 'C:\\Users\\bob\\AppData\\Local\\Programs\\DeepSeek Harness';
  const found = detectInstall({ env: ENV, fsLike: fakeFs([path.win32.join(dir, DSH_EXE_NAME)]) });
  assert.ok(found);
  assert.equal(found.installDir, dir);
  assert.ok(found.cli.endsWith('cli.js'));
});

test('装在 D:\\deepseek（本机那种装法）也能探测到', () => {
  const dir = 'D:\\deepseek';
  const found = detectInstall({ env: ENV, fsLike: fakeFs([path.win32.join(dir, DSH_EXE_NAME)]) });
  assert.equal(found?.installDir, dir);
});

test('哪都没有就返回 null，不瞎猜一个默认路径', () => {
  assert.equal(detectInstall({ env: ENV, fsLike: fakeFs([]) }), null);
});

test('候选目录都没命中时，会去扫各盘根下名字像 deepseek 的文件夹', () => {
  const dir = 'E:\\some-deepseek-portable';
  const fsLike = {
    existsSync: (p) => path.win32.normalize(p) === path.win32.normalize(path.win32.join(dir, DSH_EXE_NAME)),
    readdirSync: (root) => {
      if (root !== 'E:\\') throw new Error('ENOENT');
      return [{ name: 'some-deepseek-portable', isDirectory: () => true }];
    },
  };
  const found = detectInstall({ env: ENV, fsLike });
  assert.equal(found?.installDir, dir);
});

test('--dsh-dir 优先于自动探测，哪怕探测能命中别的目录', () => {
  const wrong = 'C:\\Users\\bob\\AppData\\Local\\Programs\\DeepSeek Harness';
  const right = 'F:\\Tools\\DeepSeek Harness';
  const r = resolveDshPaths({
    dshDir: right,
    env: ENV,
    fsLike: fakeFs([
      path.win32.join(wrong, DSH_EXE_NAME),
      path.win32.join(right, DSH_EXE_NAME),
      cliPathFor(right),
    ]),
  });
  assert.equal(r.installDir, right);
  assert.equal(r.source, 'arg');
  assert.deepEqual(r.missing, []);
});

test('config.json 的 dshInstall 也能生效，source 记为 config', () => {
  const dir = 'F:\\Tools\\DeepSeek Harness';
  const r = resolveDshPaths({
    configDir: dir,
    env: ENV,
    fsLike: fakeFs([path.win32.join(dir, DSH_EXE_NAME), cliPathFor(dir)]),
  });
  assert.equal(r.installDir, dir);
  assert.equal(r.source, 'config');
});

test('单文件环境变量（DSH_EXE/DSH_ACP_CLI）压过目录', () => {
  const dir = 'F:\\Tools\\DeepSeek Harness';
  const customExe = 'G:\\portable\\DeepSeek Harness.exe';
  const r = resolveDshPaths({
    dshDir: dir,
    env: { ...ENV, DSH_EXE: customExe, DSH_ACP_CLI: 'G:\\portable\\cli.js' },
    fsLike: fakeFs([customExe, 'G:\\portable\\cli.js', path.win32.join(dir, DSH_EXE_NAME)]),
  });
  assert.equal(r.exe, customExe);
  assert.equal(r.cli, 'G:\\portable\\cli.js');
  assert.equal(r.source, 'env-file');
});

test('找不到时 missing 里写清缺什么，且带上找过的候选', () => {
  const r = resolveDshPaths({ env: ENV, fsLike: fakeFs([]) });
  assert.equal(r.source, 'none');
  assert.equal(r.missing.length, 2);
  assert.ok(r.missing[0].startsWith('exe:'));
  assert.ok(r.missing[1].startsWith('cli:'));
  assert.ok(r.tried.length > 0);
});

test('sherpa 缺失只是 warning，不阻断启动', () => {
  const dir = 'D:\\deepseek';
  const r = resolveDshPaths({
    dshDir: dir,
    env: ENV,
    fsLike: fakeFs([path.win32.join(dir, DSH_EXE_NAME), cliPathFor(dir)]),
  });
  assert.deepEqual(r.missing, []);
  assert.equal(r.warnings.length, 1);
  assert.ok(r.warnings[0].startsWith('sherpa:'));
});

test('提示文案包含「怎么指定目录」和「找过哪」，不能只说一句失败', () => {
  const hint = notFoundHint(['D:\\deepseek\\DeepSeek Harness.exe', 'C:\\Program Files\\DeepSeek Harness\\DeepSeek Harness.exe']);
  assert.match(hint, /--dsh-dir/);
  assert.match(hint, /config\.json/);
  assert.match(hint, /dshInstall/);
  assert.match(hint, /找过这些位置/);
});

test('asar 里的 cli 不按普通文件判断（fs 看不进 asar，判 false 会误报缺失）', () => {
  const dir = 'D://deepseek';
  // 只让 exe 存在，cli 在 asar 里 → fakeFs 必然说 false
  const r = resolveDshPaths({
    dshDir: dir,
    env: ENV,
    fsLike: fakeFs([path.win32.join(dir, DSH_EXE_NAME)]),
  });
  assert.deepEqual(r.missing, [], 'asar 内的 cli 不该被当成缺失');
  assert.ok(r.cli.includes('app.asar'));
});

test('isInsideAsar 认得出 app.asar，但把 app.asar.unpacked 当真实目录', () => {
  assert.equal(isInsideAsar('D://x//resources//app.asar//a//b.js'), true);
  assert.equal(isInsideAsar('D://x//resources//app.asar.unpacked//a//b.node'), false);
  assert.equal(isInsideAsar('D://x//DeepSeek Harness.exe'), false);
});
