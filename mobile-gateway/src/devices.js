/**
 * 设备配对与令牌。
 *
 * 威胁模型（想清楚才能设计对）：
 * 网关一旦监听局域网，同一个 Wi-Fi 下任何设备都能连上来。DSH 能在这台电脑上
 * 执行任意命令，所以「谁能连」= 「谁能控制这台电脑」。默认回环只够测试用，
 * 一旦开给手机就**必须有第二条边界**。
 *
 * 设计要点：
 * 1. **配对码一次性 + 限时 + 限次**。6 位数字，5 分钟有效，最多试 5 次。
 *    为什么不是 8 位：用户要手输，6 位是人能一次看准的上限；靠限次而不是靠长度防爆破。
 * 2. **令牌只存哈希**。网关侧存 sha256，即使 state 目录泄漏也拿不到可用令牌。
 * 3. **定长比较**。`===` 会在第一个不同字符短路，本机进程可用时延逐字节试探。
 * 4. **设备可单独吊销**。手机丢了要能只踢掉那一台，不是重置全部。
 *
 * 存盘：`state/mobile-gateway/devices.json`（在 gitignore 覆盖范围内）。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CODES, fail } from './errors.js';

const PAIR_CODE_TTL_MS = 5 * 60 * 1000;
const PAIR_MAX_ATTEMPTS = 5;

/** 生成一个 6 位配对码（用 crypto，不用 Math.random——后者可预测）。 */
export function makePairCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

/** 令牌：32 字节随机数，base64url 无填充。 */
export function makeToken() {
  return crypto.randomBytes(32).toString('base64url');
}

/** 令牌哈希。用 sha256 而不是 bcrypt：令牌本身是 256 位随机数，不需要慢哈希。 */
export function hashToken(token) {
  return crypto.createHash('sha256').update(String(token ?? ''), 'utf8').digest('hex');
}

/** 定长比较两个十六进制串。长度不同直接 false。 */
export function safeEqualHex(a, b) {
  const left = Buffer.from(String(a ?? ''), 'utf8');
  const right = Buffer.from(String(b ?? ''), 'utf8');
  if (left.length === 0 || left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

/**
 * 设备存储。读盘失败**不抛**——文件坏了应该当成「没有设备」，
 * 让用户重新配对，而不是让网关起不来（对齐 AGENTS.md「单个坏数据不能让服务起不来」）。
 */
export class DeviceStore {
  /**
   * @param {object} options
   * @param {string} options.file - devices.json 绝对路径
   * @param {(msg:string)=>void} [options.log]
   */
  constructor({ file, log = () => {} }) {
    this.file = file;
    this.log = log;
    /** @type {Array<{id:string,name:string,tokenHash:string,createdAt:number,lastSeenAt:number|null}>} */
    this.devices = [];
    this.pairCode = null;
    this.pairExpiresAt = 0;
    this.pairAttempts = 0;
    this._load();
  }

  _load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const doc = JSON.parse(raw);
      if (Array.isArray(doc?.devices)) {
        this.devices = doc.devices.filter(
          (d) => d && typeof d.id === 'string' && typeof d.tokenHash === 'string',
        );
      }
    } catch (e) {
      if (e?.code !== 'ENOENT') {
        // 文件存在但坏了：备份后从空开始，别静默覆盖
        this.log(`设备表读取失败（${e?.code ?? e?.message}），按空表启动`);
        this._quarantine();
      }
    }
  }

  _quarantine() {
    try {
      const bak = `${this.file}.broken-${Date.now()}`;
      fs.renameSync(this.file, bak);
      this.log(`坏设备表已隔离到 ${path.basename(bak)}`);
    } catch {
      /* 隔离失败也不能让启动挂掉 */
    }
  }

  _save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(
      tmp,
      JSON.stringify({ version: 1, devices: this.devices }, null, 2),
      'utf8',
    );
    fs.renameSync(tmp, this.file);
  }

  /** 生成新配对码，作废旧的。返回明文码（只在这一刻存在，不入盘）。 */
  issuePairCode(now = Date.now()) {
    this.pairCode = makePairCode();
    this.pairExpiresAt = now + PAIR_CODE_TTL_MS;
    this.pairAttempts = 0;
    return { code: this.pairCode, expiresAt: this.pairExpiresAt };
  }

  /** 当前配对码状态（给电脑端界面显示）。 */
  pairStatus(now = Date.now()) {
    if (!this.pairCode) return { active: false };
    if (now >= this.pairExpiresAt) return { active: false, expired: true };
    return {
      active: true,
      code: this.pairCode,
      expiresAt: this.pairExpiresAt,
      remainingMs: this.pairExpiresAt - now,
      attemptsLeft: PAIR_MAX_ATTEMPTS - this.pairAttempts,
    };
  }

  /**
   * 用配对码换设备令牌。
   * @param {object} params
   * @param {string} params.code
   * @param {string} params.deviceName
   * @returns {{deviceId:string, token:string}}
   */
  pair({ code, deviceName }, now = Date.now()) {
    if (!this.pairCode) {
      throw fail(CODES.PAIR_CODE_EXPIRED, '还没有生成配对码', {
        hint: '让电脑端先生成配对码（设置 → 手机配对）。',
      });
    }
    if (now >= this.pairExpiresAt) {
      this.pairCode = null;
      throw fail(CODES.PAIR_CODE_EXPIRED, '配对码已过期', {});
    }
    if (this.pairAttempts >= PAIR_MAX_ATTEMPTS) {
      this.pairCode = null;
      throw fail(CODES.PAIR_RATE_LIMITED, `配对码输错次数过多（${PAIR_MAX_ATTEMPTS} 次），已作废`, {});
    }

    const supplied = String(code ?? '').trim();
    // 定长比较：两个 6 位数字串
    const expected = Buffer.from(this.pairCode, 'utf8');
    const got = Buffer.from(supplied.padEnd(6, '\0').slice(0, 6), 'utf8');
    const match = got.length === expected.length && crypto.timingSafeEqual(got, expected);

    if (!match) {
      this.pairAttempts += 1;
      const left = PAIR_MAX_ATTEMPTS - this.pairAttempts;
      throw fail(
        CODES.PAIR_CODE_INVALID,
        `配对码不对（还可试 ${Math.max(0, left)} 次）`,
        left > 0 ? {} : { hint: '次数用完了，让电脑端重新生成一个配对码。' },
      );
    }

    // 配对成功：码作废（一次性），生成设备
    this.pairCode = null;
    this.pairAttempts = 0;
    const token = makeToken();
    const device = {
      id: `dev-${crypto.randomBytes(6).toString('hex')}`,
      name: String(deviceName || '未命名设备').slice(0, 60),
      tokenHash: hashToken(token),
      createdAt: now,
      lastSeenAt: null,
    };
    this.devices.push(device);
    this._save();
    return { deviceId: device.id, token };
  }

  /**
   * 校验令牌。
   * @returns {object|null} 命中的设备记录；不命中返回 null（**不要抛**，让调用方决定怎么响应）
   */
  verify(token, now = Date.now()) {
    const h = hashToken(token);
    for (const device of this.devices) {
      if (safeEqualHex(device.tokenHash, h)) {
        device.lastSeenAt = now;
        return device;
      }
    }
    return null;
  }

  /** 记录最近活跃（不每次都写盘，太频繁；由调用方按需节流）。 */
  touch(deviceId, now = Date.now()) {
    const d = this.devices.find((x) => x.id === deviceId);
    if (d) d.lastSeenAt = now;
  }

  /** 吊销一台设备。 */
  revoke(deviceId) {
    const before = this.devices.length;
    this.devices = this.devices.filter((d) => d.id !== deviceId);
    if (this.devices.length === before) {
      throw fail(CODES.NOT_FOUND, `没有这台设备：${deviceId}`, {});
    }
    this._save();
    return { revoked: deviceId, remaining: this.devices.length };
  }

  /** 列出设备（**绝不返回 tokenHash**）。 */
  list() {
    return this.devices.map((d) => ({
      id: d.id,
      name: d.name,
      createdAt: d.createdAt,
      lastSeenAt: d.lastSeenAt,
    }));
  }

  flush() {
    this._save();
  }
}
