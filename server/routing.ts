/**
 * 群聊消息的 agent 路由决策。
 *
 * 抽成纯函数是为了让优先级规则可测——历史上 applicationIntent 会无条件
 * 覆盖用户的显式 @，导致「@简历专家 投递时要注意什么」被路由给投递管家。
 */

export type RouteName = "explicit_at" | "application_delegate" | "default";

/** 投递意图关键词。仅在用户没有显式点名时才生效。 */
export const APPLICATION_INTENT_RE = /投递|投这|帮.*投|请.*投|申请这个岗位|apply/i;

/**
 * 找出用户显式点名的 agent id。
 * 支持两种写法：引用回复「回复 某人：」与 @某人。都没有则返回 null。
 */
export function detectExplicitAgentId(
  text: string,
  nameToId: Record<string, string>
): string | null {
  const replyMatch = text.match(/回复\s+\*{0,2}([一-龥A-Za-z\d]+)\*{0,2}[：:]/);
  if (replyMatch) {
    const id = nameToId[replyMatch[1]];
    if (id) return id;
  }

  for (const [name, id] of Object.entries(nameToId)) {
    if (text.includes("@" + name)) return id;
  }

  return null;
}

/**
 * 决定这条消息交给谁。优先级：显式点名 > 投递意图 > 默认调度者。
 */
export function resolveRoute(input: {
  text: string;
  nameToId: Record<string, string>;
  defaultAgentId: string;
  applicationAgentId: string;
}): { agentId: string; route: RouteName } {
  const explicit = detectExplicitAgentId(input.text, input.nameToId);
  if (explicit) return { agentId: explicit, route: "explicit_at" };

  if (APPLICATION_INTENT_RE.test(input.text)) {
    return { agentId: input.applicationAgentId, route: "application_delegate" };
  }

  return { agentId: input.defaultAgentId, route: "default" };
}
