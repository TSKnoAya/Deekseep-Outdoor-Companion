/**
 * ACP profile 的「默认模型」读写。
 *
 * 背景：手机网关每次启动都会 spawn 一个 DSH 子进程（`--profile acp`），
 * 而 **ACP 用哪个模型是写死在 `@deepseek-ai/dsh-acp` 的 config 里的**：
 *   - id: acp
 *     config: { provider: deepseek-official, model: deepseek-v4-flash }
 * 用户桌面端用的是另一套（`agent-default-model`），ACP 读不到。
 *
 * 所以「换模型」这件事 = 改写 `~/.dsh/profiles/acp/cordis.patch.yml` 里 `- id: acp`
 * 那一段，然后让网关重启 ACP 子进程。
 *
 * 这里的实现只管**文件那一半**，纯函数 + 可注入 fs，便于测试。
 */

import fs from 'node:fs';
import path from 'node:path';

const MARKER = '# === mobile-gateway: acp 模型（由插件/网关维护，可手工改） ===';

/** 找出 YAML 里 `- id: acp` 那一段的行区间（含结尾空行）。 */
export function findAcpBlock(lines) {
  const start = lines.findIndex((l) => /^-\s*id:\s*acp\s*$/.test(l.trimEnd()));
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    // 下一个顶层条目（顶格的 "- "）就是本段结束
    if (/^-\s/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return { start, end };
}

/** 从文本里读出当前的 provider / model。读不到返回 null。 */
export function readAcpModel(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const range = findAcpBlock(lines);
  if (!range) return null;
  const seg = lines.slice(range.start, range.end).join('\n');
  const provider = seg.match(/^\s*provider:\s*['"]?([^'"\s]+)['"]?/m)?.[1] ?? null;
  const model = seg.match(/^\s*model:\s*['"]?([^'"\s]+)['"]?/m)?.[1] ?? null;
  if (!provider && !model) return null;
  return { provider, model };
}

/**
 * 生成新的 patch 文本：替换（或追加）`- id: acp` 段，其它内容原样保留。
 * 幂等：同样输入跑两次结果相同。
 */
export function withAcpModel(text, { provider, model }) {
  const src = String(text ?? '');
  // 先把自己以前留下的标记注释去掉，否则每写一次就多一行（幂等性靠这一步）
  const lines = src.split(/\r?\n/).filter((l) => l.trim() !== MARKER);
  const block = [
    MARKER,
    '- id: acp',
    "  name: '@deepseek-ai/dsh-acp'",
    '  config:',
    `    provider: ${provider}`,
    `    model: ${model}`,
  ];

  const range = findAcpBlock(lines);
  let next;
  if (range) {
    next = [...lines.slice(0, range.start), ...block, ...lines.slice(range.end)];
  } else {
    // 没有就追加到末尾（保留原文件里的注释与其它条目）
    const base = src.endsWith('\n') || src === '' ? lines : [...lines];
    next = [...base.filter((l, i) => !(i === base.length - 1 && l === '')), ...block, ''];
  }
  // 压缩连续空行到最多一行
  const out = [];
  for (const l of next) {
    if (l === '' && out[out.length - 1] === '') continue;
    out.push(l);
  }
  return `${out.join('\n').replace(/\n*$/, '')}\n`;
}

export function profilePath(dshHome) {
  return path.join(dshHome, 'profiles', 'acp', 'cordis.patch.yml');
}

/**
 * 读当前模型。文件不存在时返回 `{profileExists:false}`——UI 要能区分
 * 「没启动过网关」和「配置里没有 acp 段」。
 */
export function loadAcpModel(dshHome, fsLike = fs) {
  const file = profilePath(dshHome);
  let text = null;
  try {
    text = fsLike.readFileSync(file, 'utf8');
  } catch (e) {
    if (e?.code === 'ENOENT') return { profileExists: false, file, current: null };
    throw e;
  }
  return { profileExists: true, file, current: readAcpModel(text) };
}

/**
 * 写回模型。**写之前先备份**（用户可能手改过这个文件）。
 * @returns {{file:string, backup:string|null, current:{provider:string,model:string}}}
 */
export function saveAcpModel(dshHome, { provider, model }, fsLike = fs) {
  if (!provider || !model) {
    const err = new Error('provider 和 model 都必须给');
    err.code = 'bad-request';
    throw err;
  }
  if (!/^[\w.\-/]+$/.test(provider) || !/^[\w.\-/]+$/.test(model)) {
    const err = new Error('provider/model 只允许字母数字与 . _ - / 这类字符');
    err.code = 'bad-request';
    throw err;
  }
  const file = profilePath(dshHome);
  fsLike.mkdirSync(path.dirname(file), { recursive: true });
  let text = '';
  let backup = null;
  try {
    text = fsLike.readFileSync(file, 'utf8');
    backup = `${file}.bak-${Date.now()}`;
    fsLike.writeFileSync(backup, text, 'utf8');
  } catch (e) {
    if (e?.code !== 'ENOENT') throw e;
  }
  fsLike.writeFileSync(file, withAcpModel(text, { provider, model }), 'utf8');
  return { file, backup, current: { provider, model } };
}
