// @ts-check
/**
 * 定时调用接口服务（Keep-Alive / 心跳）
 *
 * 由 Cron（每 10 分钟一条）触发，也可通过 POST /api/api-calls/run 手动触发。
 * 从 KV `api_call_targets` 读取目标列表，逐个发起 HTTP 请求，结果写入
 * KV `apicall_log:{ISO_UTC}`（1 小时 TTL，ISO 字典序 == 时间序）。
 *
 * 典型用途：
 *   - 定时 ping Render 免费实例，防止 15 分钟无流量休眠
 *   - 定时写 Supabase 心跳表，防止免费项目 7 天不活跃被暂停
 *
 */

import { getKVJson } from '../data/kv.js';
import { getConfig } from '../data/config.js';
import { cronMatches, isValidCron } from '../core/cron-match.js';

const TARGETS_KEY = 'api_call_targets';
const LOG_PREFIX = 'apicall_log:';
const LOG_TTL_SEC = 60 * 60;
const TIMEOUT_MS = 15000;
const MAX_LOGS = 500;
const MAX_TARGETS = 50;
const ALLOWED_METHODS = ['GET', 'POST', 'PUT', 'HEAD', 'DELETE'];
/** 目标未填 cron 时的默认调度：每 10 分钟 */
export const DEFAULT_TARGET_CRON = '*/10 * * * *';

/**
 * @typedef {Object} ApiCallTarget
 * @property {string} id
 * @property {string} name
 * @property {string} url
 * @property {string} method
 * @property {string} headers 每行一条 "Key: Value"
 * @property {string} body
 * @property {string} cron 5 字段 cron 表达式（非法时归一化为默认值）
 * @property {boolean} enabled
 */

/**
 * 归一化目标列表：去重、截断、剔除非法 URL。
 *
 * @param {any} raw
 * @returns {ApiCallTarget[]}
 */
export function normalizeTargets(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const seen = new Set();
  /** @type {ApiCallTarget[]} */
  const out = [];
  for (const t of list) {
    if (!t || typeof t !== 'object') continue;
    const url = String(t.url || '').trim();
    if (!/^https?:\/\//i.test(url)) continue;
    const id = String(t.id || crypto.randomUUID());
    if (seen.has(id)) continue;
    seen.add(id);
    const method = String(t.method || 'GET').toUpperCase();
    const cron = String(t.cron || '').trim();
    out.push({
      id,
      name: String(t.name || '未命名目标').slice(0, 100),
      url,
      method: ALLOWED_METHODS.includes(method) ? method : 'GET',
      headers: String(t.headers || '').slice(0, 2000),
      body: String(t.body || '').slice(0, 8000),
      // 非法/为空的 cron 回退默认值，保证老数据无需迁移
      cron: isValidCron(cron) ? cron : DEFAULT_TARGET_CRON,
      enabled: t.enabled !== false
    });
  }
  return out.slice(0, MAX_TARGETS);
}

/**
 * 读取目标列表。
 *
 * @param {{ SUBSCRIPTIONS_KV: KVNamespace }} env
 * @returns {Promise<ApiCallTarget[]>}
 */
export async function getTargets(env) {
  return normalizeTargets(await getKVJson(env, TARGETS_KEY, []));
}

/**
 * 保存目标列表（写入前归一化）。
 *
 * @param {{ SUBSCRIPTIONS_KV: KVNamespace }} env
 * @param {any} list
 * @returns {Promise<ApiCallTarget[]>}
 */
export async function saveTargets(env, list) {
  const normalized = normalizeTargets(list);
  await env.SUBSCRIPTIONS_KV.put(TARGETS_KEY, JSON.stringify(normalized));
  return normalized;
}

/**
 * 解析多行 "Key: Value" 文本为 headers 对象。
 *
 * @param {string} raw
 * @returns {Record<string, string>}
 */
function parseHeaders(raw) {
  /** @type {Record<string, string>} */
  const headers = {};
  for (const line of String(raw || '').split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const k = line.slice(0, idx).trim();
    const v = line.slice(idx + 1).trim();
    if (k) headers[k] = v;
  }
  return headers;
}

/**
 * 执行单个目标的调用（带 15 秒超时）。
 *
 * @param {ApiCallTarget} target
 * @returns {Promise<any>}
 */
async function callTarget(target) {
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  /** @type {any} */
  const result = {
    targetId: target.id,
    name: target.name,
    url: target.url,
    method: target.method,
    cron: target.cron,
    startedAt
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    /** @type {RequestInit} */
    const init = {
      method: target.method,
      headers: parseHeaders(target.headers),
      redirect: 'follow',
      signal: controller.signal
    };
    if (target.method !== 'GET' && target.method !== 'HEAD' && target.body) {
      init.body = target.body;
    }
    const res = await fetch(target.url, init);
    const text = await res.text();
    result.status = res.ok ? 'success' : 'failed';
    result.httpStatus = res.status;
    result.durationMs = Date.now() - startedMs;
    result.responseSnippet = String(text).slice(0, 500);
  } catch (err) {
    result.status = 'failed';
    result.error =
      err && /** @type {any} */ (err).name === 'AbortError'
        ? `超时（${TIMEOUT_MS}ms）`
        : err && err.message
          ? err.message
          : String(err);
    result.durationMs = Date.now() - startedMs;
  } finally {
    clearTimeout(timer);
  }
  return result;
}

/**
 * 测试单个目标：按弹窗里当前填写的内容真实调用一次。
 * 不落库、不写调用日志，仅供前端「测试」按钮使用。
 *
 * @param {{ SUBSCRIPTIONS_KV: KVNamespace }} _env 未使用（保留参数位以便与其它服务函数签名一致）
 * @param {any} raw 前端提交的目标字段（可只填部分）
 * @returns {Promise<{ok: boolean, message?: string, result?: any}>}
 */
export async function testTarget(_env, raw) {
  const normalized = normalizeTargets([raw]);
  if (!normalized.length) {
    return { ok: false, message: 'URL 无效：需以 http:// 或 https:// 开头' };
  }
  return { ok: true, result: await callTarget(normalized[0]) };
}

/**
 * 执行定时调用并写一条聚合日志。
 *
 * @param {{ SUBSCRIPTIONS_KV: KVNamespace }} env
 * @param {Object} [options]
 * @param {boolean} [options.scheduled=false] true 表示由每分钟 Cron 触发：只调用
 *   「当前分钟命中各自 cron 表达式」的目标，且一个都没命中时不写日志；
 *   false（手动触发）则执行全部启用的目标。
 * @returns {Promise<any>}
 */
export async function runApiCalls(env, { scheduled = false } = {}) {
  const startedAtIso = new Date().toISOString();
  const enabled = (await getTargets(env)).filter((t) => t.enabled);
  if (enabled.length === 0) {
    return { startedAt: startedAtIso, finishedAt: new Date().toISOString(), total: 0, success: 0, failed: 0, results: [] };
  }

  let targets = enabled;
  if (scheduled) {
    const timezone = (await getConfig(env)).TIMEZONE || 'UTC';
    const now = new Date();
    targets = enabled.filter((t) => cronMatches(t.cron, now, timezone));
    if (targets.length === 0) {
      // 本分钟没有任何目标命中调度，直接返回，不写日志（避免 KV 被空记录填满）
      return { startedAt: startedAtIso, finishedAt: new Date().toISOString(), skipped: true, total: 0, success: 0, failed: 0, results: [] };
    }
  }

  const results = await Promise.all(targets.map(callTarget));
  const success = results.filter((r) => r.status === 'success').length;
  const entry = {
    startedAt: startedAtIso,
    finishedAt: new Date().toISOString(),
    total: results.length,
    success,
    failed: results.length - success,
    results
  };
  try {
    await env.SUBSCRIPTIONS_KV.put(LOG_PREFIX + startedAtIso, JSON.stringify(entry), {
      expirationTtl: LOG_TTL_SEC
    });
  } catch (err) {
    console.error('[api-caller] 写日志失败:', err);
  }
  return entry;
}

/**
 * 读取最近 N 次调用日志（按时间倒序）。
 *
 * @param {{ SUBSCRIPTIONS_KV: KVNamespace }} env
 * @param {number} [limit=30]
 * @returns {Promise<any[]>}
 */
export async function getRecentLogs(env, limit = 30) {
  const safeLimit = Math.min(100, Math.max(1, Number(limit) || 30));
  const keys = [];
  let cursor;
  do {
    const res = await env.SUBSCRIPTIONS_KV.list({ prefix: LOG_PREFIX, cursor, limit: 1000 });
    for (const k of res.keys) keys.push(k.name);
    cursor = res.list_complete ? undefined : res.cursor;
  } while (cursor && keys.length < MAX_LOGS);
  keys.sort((a, b) => b.localeCompare(a));
  const top = keys.slice(0, safeLimit);
  const items = await Promise.all(
    top.map(async (key) => {
      const raw = await env.SUBSCRIPTIONS_KV.get(key);
      if (!raw) return null;
      try {
        return { key, ...JSON.parse(raw) };
      } catch {
        return null;
      }
    })
  );
  return items.filter((x) => x != null);
}
