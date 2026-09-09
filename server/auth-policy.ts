/**
 * 免认证白名单与会话 cookie 的纯策略。零依赖，不 import server.ts、不读取
 * 任何进程状态（除了显式传进来的参数），照 routing.ts / tenancy.ts 的先例
 * 抠成独立模块，方便单测钉住配置本身而不是手抄的副本。
 */

/** 前缀表：这一类路径下的所有子路径都豁免登录，如 /api/auth/login、/api/auth/register。 */
export const AUTH_EXEMPT_PREFIX = ["/api/auth/"];

// 精确匹配，不能放进前缀表：前缀匹配会把 /api/health-anything 也一起放过去，
// 需要登录的 /api/extension/pair-code 同理会被 /api/extension/pair 的前缀捎带免认证。
export const AUTH_EXEMPT_EXACT = ["/api/extension/pair", "/api/health"];

/**
 * 该路径是否豁免登录。纯函数，不读取任何进程状态，方便单测覆盖。
 *
 * 前缀表只用于「这一类路径下的所有子路径」（如 /api/auth/login、/api/auth/register）；
 * 需要豁免但又不能被前缀误伤兄弟路径的（/api/health 之于 /api/health-anything，
 * /api/extension/pair 之于需要登录的 /api/extension/pair-code）一律放精确匹配表。
 */
export function isAuthExempt(path: string, exemptPrefixes: string[], exemptExact: string[]): boolean {
  return exemptPrefixes.some((p) => path.startsWith(p)) || exemptExact.includes(path);
}

export function sessionCookie(token: string, sessionTtlMs: number, env: NodeJS.ProcessEnv = process.env): string {
  const secure = env.NODE_ENV === "production" ? "; Secure" : "";
  return `paw_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${sessionTtlMs / 1000}${secure}`;
}
