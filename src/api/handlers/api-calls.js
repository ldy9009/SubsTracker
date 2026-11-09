// @ts-check
/**
 * 定时调用（Keep-Alive）路由
 *
 * 接口表（路径前缀 /api）：
 *   GET    /api/api-calls          读取目标列表
 *   PUT    /api/api-calls          保存目标列表（整体替换）
 *   POST   /api/api-calls/run      手动触发一次全部启用的目标
 *   GET    /api/api-calls/logs     最近调用日志 ?limit=30
 *
 * 鉴权：由 router.js 在调用本文件前统一校验（需登录），与既有路由一致。
 *
 */

import { getTargets, saveTargets, runApiCalls, getRecentLogs } from '../../services/api-caller.js';

/** 标准 JSON 响应 */
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

/**
 * 处理 /api/api-calls* 路由。返回 null 表示路径不匹配，交由调用方继续。
 *
 * @param {Request} request
 * @param {{ SUBSCRIPTIONS_KV: KVNamespace }} env
 * @param {string} path 已剥离 /api 前缀的路径
 */
export async function handleApiCallRoutes(request, env, path) {
  if (!path.startsWith('/api-calls')) return null;
  const method = request.method;
  const rest = path.slice('/api-calls'.length);

  // 目标列表
  if (rest === '' || rest === '/') {
    if (method === 'GET') {
      return json({ success: true, targets: await getTargets(env) });
    }
    if (method === 'PUT') {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ success: false, message: '请求体不是合法 JSON' }, 400);
      }
      const saved = await saveTargets(env, Array.isArray(body) ? body : body && body.targets);
      return json({ success: true, targets: saved });
    }
    return json({ success: false, message: 'Method Not Allowed' }, 405);
  }

  // 手动触发一次
  if (rest === '/run' && method === 'POST') {
    const entry = await runApiCalls(env);
    return json({ success: true, entry });
  }

  // 最近调用日志
  if (rest === '/logs' && method === 'GET') {
    const url = new URL(request.url);
    const logs = await getRecentLogs(env, Number(url.searchParams.get('limit') || 30));
    return json({ success: true, logs });
  }

  return null;
}
