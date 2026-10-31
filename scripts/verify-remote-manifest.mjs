// 远程清单核对：直接读 GitHub 上某个 tag 的 **git blob**，逐文件比 sha256。
//
// 为什么需要它：`codeload.github.com` 在部分网络下会挂（下载卡住），但 `api.github.com`
// 仍然可用。归档 zip 的内容就是这些 blob（无 filter），所以按 blob 核对等价于核对归档，
// 而且能作为发版门禁的备用通道（AGENTS §1.8 第 3 条）。
//
// 用法：GH_TOKEN=... node scripts/verify-remote-manifest.mjs <owner/repo> <tag>
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = process.argv[2];
const tag = process.argv[3];
const token = process.env.GH_TOKEN;
if (!repo || !tag) { console.error('用法：verify-remote-manifest.mjs <owner/repo> <tag>'); process.exit(2); }

const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'surfcore-verify', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
async function api(p) {
  for (let i = 0; i < 3; i += 1) {
    try {
      const res = await fetch(`https://api.github.com${p}`, { headers, signal: AbortSignal.timeout(30_000) });
      if (res.status === 403 || res.status === 429) throw new Error(`rate limited: ${res.status}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      if (i === 2) throw e;
      await new Promise((r) => setTimeout(r, 800 * (i + 1)));
    }
  }
}

const manifest = JSON.parse(fs.readFileSync(path.join(root, 'release', 'install-manifest.json'), 'utf8'));
const want = manifest.files ?? {};

let commitSha = (await api(`/repos/${repo}/git/ref/tags/${tag}`)).object?.sha;
const obj = await api(`/repos/${repo}/git/commits/${commitSha}`).catch(() => null);
if (!obj?.tree) {
  const tagObj = await api(`/repos/${repo}/git/tags/${commitSha}`);
  commitSha = tagObj.object?.sha;
}
const commit = await api(`/repos/${repo}/git/commits/${commitSha}`);
const tree = await api(`/repos/${repo}/git/trees/${commit.tree.sha}?recursive=1`);
const blobs = new Map((tree.tree || []).filter((x) => x.type === 'blob').map((x) => [x.path, x.sha]));

const keys = Object.keys(want);
const missing = keys.filter((k) => !blobs.has(k));
const results = { ok: 0, mismatch: [], missing, extraTracked: 0 };
const CONCURRENCY = 8;
let idx = 0;
async function worker() {
  while (idx < keys.length) {
    const rel = keys[idx++];
    if (missing.includes(rel)) continue;
    const b = await api(`/repos/${repo}/git/blobs/${blobs.get(rel)}`);
    const buf = Buffer.from(String(b.content || '').replace(/\n/g, ''), b.encoding === 'base64' ? 'base64' : 'utf8');
    const hash = crypto.createHash('sha256').update(buf).digest('hex');
    if (hash === want[rel]) results.ok += 1;
    else results.mismatch.push(rel);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

console.log(`远程核对 ${repo}@${tag}（${commitSha.slice(0, 7)}）：清单 ${keys.length} 个 · 一致 ${results.ok} · 不符 ${results.mismatch.length} · 缺失 ${missing.length}`);
for (const rel of results.mismatch.slice(0, 10)) console.log(`  ✗ 不符：${rel}`);
for (const rel of missing.slice(0, 10)) console.log(`  ✗ 缺失：${rel}`);
if (results.mismatch.length || missing.length) process.exit(1);
console.log('✅ 远程存储的内容与安装清单逐字节一致');
