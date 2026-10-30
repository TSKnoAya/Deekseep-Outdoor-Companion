#!/usr/bin/env node
/**
 * 把 ACP profile 的默认模型改成本机可用的一条。
 *
 * 为什么需要这个脚本：`@deepseek-ai/dsh-acp` 的默认 config 写死了
 *   provider: deepseek-official   # API-key 型
 *   model: deepseek-v4-flash
 * 而网关拉起的 ACP 子进程是**全新实例**，读不到桌面端登录态的模型路由，
 * 所以手机一发消息就报：
 *   llm-deepseek: no API key for provider route "deepseek-official"
 * 这不是网关的 bug，是 DSH 的 ACP profile 缺少模型配置。
 *
 * 用法：
 *   node scripts/setup-acp-model.mjs                      # 用账号型 provider（推荐，需已登录 DSH）
 *   node scripts/setup-acp-model.mjs --provider our-free-model --model kilo-auto/free
 *   node scripts/setup-acp-model.mjs --dry-run             # 只打印要写什么
 *
 * 安全性：写之前备份；文件里已有别的条目时**不覆盖**，只打印要手工合并的片段。
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes(name);

const provider = argOf('--provider', 'deepseek-account');
const model = argOf('--model', 'deepseek-v4.1-flash');
const dryRun = has('--dry-run');

const home = process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.cwd(), '.dsh');
const profileDir = path.join(home, 'profiles', 'acp');
const patchFile = path.join(profileDir, 'cordis.patch.yml');

const block = `# 手机网关用的 ACP profile：把 ACP 会话默认模型从 API-key 型换成可用的一条。
# 模板由 mobile-gateway/scripts/setup-acp-model.mjs 生成。
- id: acp
  name: '@deepseek-ai/dsh-acp'
  config:
    provider: ${provider}
    model: ${model}
`;

/** 判断文件里有没有「实质条目」（去掉注释和空行后是否还有内容）。 */
function hasEntries(text) {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .some((l) => l !== '[]');
}

const main = () => {
  if (!fs.existsSync(profileDir)) {
    console.error(`没找到 ACP profile：${profileDir}`);
    console.error('先启动一次 DSH（或跑一次网关），让它把这个目录建出来。');
    process.exit(1);
  }

  const existing = fs.existsSync(patchFile) ? fs.readFileSync(patchFile, 'utf8') : '';

  if (hasEntries(existing)) {
    console.log(`⚠️  ${patchFile} 里已经有配置，脚本不覆盖（怕弄坏你手写的东西）。`);
    console.log('请手工把下面这段合并进去（或先备份、清空该文件再跑本脚本）：\n');
    console.log(block);
    process.exit(2);
  }

  if (dryRun) {
    console.log(`会写入 ${patchFile}：\n`);
    console.log(block);
    return;
  }

  if (existing) {
    const backup = `${patchFile}.bak-${Date.now()}`;
    fs.copyFileSync(patchFile, backup);
    console.log(`已备份原文件 → ${backup}`);
  }
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(patchFile, block, 'utf8');
  console.log(`已写入 ${patchFile}`);
  console.log(`默认模型：${provider} / ${model}`);
  console.log('');
  console.log('下一步：重启网关（关掉窗口重新 node src/main.js --listen 0.0.0.0:8788），');
  console.log('然后跑一次 node test/e2e-smoke.mjs 验证——看到 text 事件就说明整条链通了。');
  console.log('');
  console.log('注意：如果 --provider 用的是自定义插件（比如 our-free-model），');
  console.log('还要先把它装进 acp profile：');
  console.log('  dsh plugin --profile acp add <包名或 tgz 路径>');
};

main();
