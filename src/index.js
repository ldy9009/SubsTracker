// @ts-check
/**
 * Worker 入口
 *
 * fetch handler 委托给 Hono 应用（src/app.js）。
 * scheduled handler 触发定时任务执行。
 *
 */

import app from './app.js';
import { ensureMigrations } from './data/migrate.js';
import { checkExpiringSubscriptions } from './services/scheduler.js';
import { runApiCalls } from './services/api-caller.js';

export default {
  fetch: app.fetch,

  /**
   * 每小时由 Cron 触发一次。
   *
   * @param {ScheduledEvent} event
   * @param {{ SUBSCRIPTIONS_KV: KVNamespace }} env
   * @param {ExecutionContext} ctx
   */
  async scheduled(event, env, ctx) {
    void ctx;
    try {
      await ensureMigrations(env);
    } catch (err) {
      console.error('[index] scheduled 迁移失败:', err);
    }
    console.log(
      '[Workers] 定时任务触发',
      'cron:',
      event?.cron || '(unknown)',
      'UTC:',
      new Date().toISOString()
    );
    // 双 cron 分发：*/10 每 10 分钟跑一次定时接口调用（Keep-Alive），
    // 其余（0 * * * *）跑订阅到期检查。互不影响。
    if (event?.cron === '*/10 * * * *') {
      await runApiCalls(env);
      return;
    }
    await checkExpiringSubscriptions(env);
  }
};
