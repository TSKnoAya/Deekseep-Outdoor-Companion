/**
 * 播报策略：决定「这句话要不要念、念哪一段」。
 *
 * 为什么单独成模块而不是塞进路由：这段逻辑有 4 档 × 3 条硬规则，
 * 是 App 端最容易做歪、也最容易出现「念了不该念的」的地方。
 * 把它做成**纯函数**，就能穷举测试——不需要麦克风也不需要 TTS 服务。
 *
 * 四档（用户已经确认够用）：
 *   all         每条都念
 *   short       只念短回答（默认）
 *   headset-only 只在耳机/免提时念
 *   off         只显示不念
 *
 * 三条硬规则（不分档位都生效）：
 *   1. 代码块 / 表格 / 文件路径不念
 *   2. 首句优先：长的只念到第一个句号
 *   3. 空内容、纯符号不念
 */

/** 短回答阈值：超过就只念首句。80 字约等于 15~20 秒语音，再长就吵了。 */
export const SHORT_LIMIT = 80;

/**
 * 需要剔除的片段：代码块、行内代码、表格、链接、路径。
 *
 * 顺序有讲究（这里是实测踩出来的，改顺序会出 bug）：
 * - 先摘 fenced code（三反引号），否则里面的 ``` 会污染后续判断；
 * - 再摘行内 code；
 * - **URL 必须排在路径前面**：路径正则 `/(?:[\w.-]+\/){2,}[\w.-]+`
 *   会把 `https://example.com/a/b/c` 从中间切掉，只剩 `https:`，
 *   于是「链接不念」这条就失效了（单测抓到的）；
 * - 路径最后，因为它可能匹配到代码里的东西。
 */
const STRIP_RULES = [
  { name: 'fenced-code', re: /```[\s\S]*?```/g },
  { name: 'inline-code', re: /`[^`\n]+`/g },
  { name: 'table', re: /^\s*\|.*\|\s*$/gm },
  { name: 'url', re: /https?:\/\/\S+/g },
  { name: 'path', re: /(?:[A-Za-z]:\\[^\s，。；]+|\/(?:[\w.-]+\/){2,}[\w.-]+)/g },
  { name: 'markdown-heading', re: /^\s*#{1,6}\s+/gm },
  { name: 'markdown-bullet', re: /^\s*[-*+]\s+/gm },
];

/**
 * 把不适合朗读的内容剔掉，留下能念的正文。
 * @param {string} text
 * @returns {string}
 */
export function stripUnreadable(text) {
  let out = String(text ?? '');
  for (const rule of STRIP_RULES) out = out.replace(rule.re, ' ');
  // 压缩空白：语音引擎遇到连续空行会拖长停顿。
  // 注意顺序——先压空格再压换行，最后还要把行首行尾的残留空格去掉，
  // 否则会得到 "你好 \n 世界" 这种夹着空格的文本（单测抓到的）。
  out = out
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
  return out;
}

/**
 * 取首句。中文按 。！？ 断，英文按 .!? 断，取不到就整段。
 * @param {string} text
 * @returns {string}
 */
export function firstSentence(text) {
  const s = String(text ?? '').trim();
  if (!s) return '';
  const m = s.match(/^[\s\S]*?[。！？!?](?=\s|$|[\s\S])/);
  if (m && m[0].trim()) return m[0].trim();
  // 没有句末标点：截到阈值，尽量在标点/空格处断开
  if (s.length <= SHORT_LIMIT) return s;
  const head = s.slice(0, SHORT_LIMIT);
  const cut = Math.max(head.lastIndexOf('，'), head.lastIndexOf(','), head.lastIndexOf(' '));
  return (cut > 20 ? head.slice(0, cut) : head).trim();
}

/**
 * 决定这条该不该念、念什么。
 *
 * @param {object} params
 * @param {string} params.text - 原始回答
 * @param {'all'|'short'|'headset-only'|'off'} [params.mode]
 * @param {boolean} [params.headsetConnected] - 当前是否连着耳机/免提
 * @param {number} [params.shortLimit]
 * @returns {{speak:boolean, reason:string, text:string}}
 */
export function decideAnnouncement({ text, mode = 'short', headsetConnected = false, shortLimit = SHORT_LIMIT }) {
  const raw = String(text ?? '').trim();

  if (mode === 'off') {
    return { speak: false, reason: 'mode-off', text: '' };
  }
  if (!raw) {
    return { speak: false, reason: 'empty', text: '' };
  }
  if (mode === 'headset-only' && !headsetConnected) {
    return { speak: false, reason: 'needs-headset', text: '' };
  }

  const readable = stripUnreadable(raw);
  if (!readable) {
    // 整条都是代码/表格/链接——念出来没有意义
    return { speak: false, reason: 'nothing-readable', text: '' };
  }
  // 纯标点 / 纯符号也不念
  if (!/[\p{L}\p{N}]/u.test(readable)) {
    return { speak: false, reason: 'no-letters', text: '' };
  }

  if (mode === 'all') {
    // 「全部播报」也不该把三页长的答案一口气念完——仍然做首句截断
    const spoken = readable.length <= shortLimit ? readable : firstSentence(readable);
    return { speak: true, reason: 'mode-all', text: spoken };
  }

  // short（默认档）：短的整条念，长的只念首句
  if (readable.length <= shortLimit) {
    return { speak: true, reason: 'short-whole', text: readable };
  }
  return { speak: true, reason: 'short-first-sentence', text: firstSentence(readable) };
}

/** 四档的机器可读清单（给 App 设置页渲染用）。 */
export const ANNOUNCE_MODES = [
  { id: 'all', label: '全部播报', description: '每条回答都念（长回答只念首句）' },
  { id: 'short', label: '只播短回答', description: `不超过 ${SHORT_LIMIT} 字的整条念，长的只念首句`, default: true },
  { id: 'headset-only', label: '仅耳机时播', description: '连着蓝牙耳机或免提时才出声' },
  { id: 'off', label: '关闭播报', description: '只显示文字，不出声' },
];
