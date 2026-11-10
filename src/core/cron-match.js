// @ts-check
/**
 * 轻量 5 字段 cron 表达式解析与匹配（分钟粒度）
 *
 * 格式：`分 时 日 月 周`，与 Vixie cron 语义一致：
 *   - 支持通配、步长（如每 10 分钟：星号 + "/10"）、范围 a-b、范围步长 a-b/n、逗号列表（如 "0,15,30 * * * *"）
 *   - 周（dow）0 与 7 都表示周日
 *   - 日（dom）与周（dow）都受限时的标准语义：任一匹配即视为匹配
 *
 * 匹配按传入时区计算（复用 src/core/time.js 的 getTimezoneDateParts），
 * 因此 "0 8 * * *" 表示的是系统配置时区（如 Asia/Shanghai）的每天 8 点。
 *
 * 设计为纯函数、零依赖，供 api-caller 服务在每分钟 Cron 触发时
 * 判断「这一分钟哪些定时调用目标需要执行」。
 */

import { getTimezoneDateParts } from './time.js';

/** 各字段取值范围（min/max） */
const FIELD_RANGES = [
  { min: 0, max: 59 }, // minute
  { min: 0, max: 23 }, // hour
  { min: 1, max: 31 }, // day of month
  { min: 1, max: 12 }, // month
  { min: 0, max: 7 } // day of week（7 会归一化为 0）
];

const CRON_FIELD_RE = /^(\*|\d+)(?:-(\d+))?(?:\/(\d+))?$/;

/**
 * 展开单个字段为合法值集合。
 *
 * @param {string} expr 字段原文（如步长写法 "星号/10"、范围 "1-5"、列表 "0,15"）
 * @param {{ min: number, max: number }} range
 * @returns {Set<number>|null} 非法表达式返回 null
 */
function expandField(expr, range) {
  /** @type {Set<number>} */
  const out = new Set();
  for (const token of String(expr).split(',')) {
    const t = token.trim();
    if (!t) return null;
    const m = t.match(CRON_FIELD_RE);
    if (!m) return null;
    const isStar = m[1] === '*';
    const start = isStar ? range.min : Number(m[1]);
    const end = m[2] !== undefined ? Number(m[2]) : isStar ? range.max : start;
    const step = m[3] !== undefined ? Number(m[3]) : 1;
    if (Number.isNaN(start) || Number.isNaN(end) || Number.isNaN(step)) return null;
    if (step < 1) return null;
    if (start < range.min || end > range.max || start > end) return null;
    for (let v = start; v <= end; v += step) {
      out.add(range.max === 7 && v === 7 ? 0 : v); // dow 7 → 周日
    }
  }
  return out;
}

/**
 * 校验并解析 cron 表达式。
 *
 * @param {string} expr
 * @returns {{ fields: Set<number>[], domStar: boolean, dowStar: boolean }|null}
 *          非法表达式返回 null；domStar/dowStar 标记「日」「周」字段是否为通配 *
 */
export function parseCron(expr) {
  const parts = String(expr || '').trim().split(/\s+/);
  if (parts.length !== 5) return null;
  /** @type {Set<number>[]} */
  const fields = [];
  for (let i = 0; i < 5; i++) {
    const set = expandField(parts[i], FIELD_RANGES[i]);
    if (!set || set.size === 0) return null;
    fields.push(set);
  }
  const isStarField = (token) => String(token).split(',').every((t) => t.trim() === '*');
  return {
    fields,
    domStar: isStarField(parts[2]),
    dowStar: isStarField(parts[4])
  };
}

/**
 * 表达式是否合法。
 *
 * @param {string} expr
 * @returns {boolean}
 */
export function isValidCron(expr) {
  return parseCron(expr) !== null;
}

/**
 * 判断表达式在指定时区的某一时刻是否匹配（分钟粒度）。
 *
 * @param {string} expr
 * @param {Date|number|string} now
 * @param {string} [timezone='UTC']
 * @returns {boolean}
 */
export function cronMatches(expr, now, timezone = 'UTC') {
  const parsed = parseCron(expr);
  if (!parsed) return false;
  const [minute, hour, dom, month, dow] = parsed.fields;

  const parts = getTimezoneDateParts(now, timezone);
  // 由「日历日期」推算星期（weekday 只取决于日期）
  const weekday = new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();

  const domMatch = dom.has(parts.day);
  const dowMatch = dow.has(weekday);
  let dayMatch;
  if (parsed.domStar && parsed.dowStar) dayMatch = true;
  else if (parsed.domStar) dayMatch = dowMatch;
  else if (parsed.dowStar) dayMatch = domMatch;
  else dayMatch = domMatch || dowMatch; // 都受限：任一匹配即通过（Vixie 语义）

  return (
    minute.has(parts.minute) &&
    hour.has(parts.hour) &&
    month.has(parts.month) &&
    dayMatch
  );
}

/**
 * 计算下一次执行时间（分钟粒度，按给定时区的墙上时间搜索）。
 *
 * 返回值约定：ISO 字符串中的「年月日时分」是 timezone 时区的墙上时间，按 UTC 编码。
 * 前端用同一时区展示（toLocaleString 的 timeZone 参数）即可还原本地时间；
 * 但它不是真实 UTC 时刻，不能用于跨时区换算或真实定时，仅供展示与排序。
 *
 * 搜索按「天」推进（每天最多 370 次，覆盖年频率表达式），不做逐分钟暴力循环。
 *
 * @param {string} expr 5 字段 cron 表达式（非法返回 null）
 * @param {Date|number} [from] 起始时刻，默认当前
 * @param {string} [timezone='UTC']
 * @param {number} [maxDays=370] 向后搜索的天数上限
 * @returns {string|null} 下一次执行的 ISO 时间；搜索范围内无匹配返回 null
 */
export function nextCronRun(expr, from = Date.now(), timezone = 'UTC', maxDays = 370) {
  const parsed = parseCron(expr);
  if (!parsed) return null;
  const [minuteSet, hourSet, dom, month, dow] = parsed.fields;
  const minutes = [...minuteSet].sort((a, b) => a - b);
  const hours = [...hourSet].sort((a, b) => a - b);

  const p = getTimezoneDateParts(from, timezone);
  const toUtc = (y, m, d, h = 0, mi = 0) => Date.UTC(y, m - 1, d, h, mi);
  const dayMatches = (y, m, d) => {
    if (!month.has(m)) return false;
    const weekday = new Date(toUtc(y, m, d)).getUTCDay();
    const domMatch = dom.has(d);
    const dowMatch = dow.has(weekday);
    if (parsed.domStar && parsed.dowStar) return true;
    if (parsed.domStar) return dowMatch;
    if (parsed.dowStar) return domMatch;
    return domMatch || dowMatch; // 都受限：任一匹配即通过（与 cronMatches 一致）
  };

  // 今天：从「下一分钟」开始找（正在执行的这一分钟不算下一次）
  if (dayMatches(p.year, p.month, p.day)) {
    for (const h of hours) {
      if (h < p.hour) continue;
      if (h === p.hour) {
        const mi = minutes.find((x) => x > p.minute);
        if (mi !== undefined) return new Date(toUtc(p.year, p.month, p.day, h, mi)).toISOString();
        continue;
      }
      return new Date(toUtc(p.year, p.month, p.day, h, minutes[0])).toISOString();
    }
  }
  // 之后的每一天：当天最早的小时/分钟
  let y = p.year;
  let m = p.month;
  let d = p.day;
  for (let i = 1; i <= maxDays; i++) {
    const dt = new Date(toUtc(y, m, d) + 86400000);
    y = dt.getUTCFullYear();
    m = dt.getUTCMonth() + 1;
    d = dt.getUTCDate();
    if (!dayMatches(y, m, d)) continue;
    return new Date(toUtc(y, m, d, hours[0], minutes[0])).toISOString();
  }
  return null;
}
