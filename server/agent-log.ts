/**
 * 协作日志（chat_log.md）的写入格式与读取渲染。
 *
 * 日志是服务端替每个 agent 自动记的动作流水——一次回复一条，内容是截断
 * 摘要而非全文（全文在群聊 pawpals_messages.json 里）。
 *
 * 条目头带上 agentId，是因为显示名不稳定：首席伴学官的显示名是用户自定
 * 的宠物名，改一次名历史就对不上了。旧条目没有这个标记，读取时一律算作
 * 队友动态——宁可少认，不能把别人的记录当成自己的。
 */

const DEFAULT_USER_LIMIT = 40;
const DEFAULT_REPLY_LIMIT = 80;

/** 压平换行，保证一条记录只占一行，并截断到上限。 */
function flatten(text: string, limit: number): string {
  return text.replace(/\s*\n+\s*/g, " ").trim().slice(0, limit);
}

export function formatLogEntry(input: {
  at: string;
  agentName: string;
  agentId: string;
  userMsg: string;
  reply: string;
  userLimit?: number;
  replyLimit?: number;
}): string {
  const user = flatten(input.userMsg, input.userLimit ?? DEFAULT_USER_LIMIT);
  const reply = flatten(input.reply, input.replyLimit ?? DEFAULT_REPLY_LIMIT);
  return `\n## ${input.at} | 🌐 PawPals → ${input.agentName} [${input.agentId}]\n用户说：「${user}」。回复摘要：${reply}…\n`;
}

type ParsedEntry = { agentId: string | null; text: string };

function parseEntries(log: string): ParsedEntry[] {
  return log
    .split(/\n(?=## )/)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.startsWith("## "))
    .map((text) => {
      const header = text.split("\n", 1)[0];
      const tag = header.match(/\[([\w-]+)\]\s*$/);
      return { agentId: tag ? tag[1] : null, text };
    });
}

/**
 * 渲染成注入用的段落：自己的历史一段，队友动态一段。
 *
 * 同一份日志分两段读，而不是笼统地取末尾 N 行——末尾 N 行里自己的记录
 * 会被队友挤掉，专家花了上下文却读不到自己上次做了什么。
 *
 * 某一段没有内容时整段省略，不留空标题。
 */
export function renderAgentLog(
  log: string,
  agentId: string,
  opts: { ownEntries: number; teamEntries: number }
): string[] {
  const entries = parseEntries(log);
  const own = entries.filter((e) => e.agentId === agentId);
  const team = entries.filter((e) => e.agentId !== agentId);

  const sections: string[] = [];

  const ownTail = own.slice(-opts.ownEntries);
  if (ownTail.length) {
    sections.push(`【你与用户的最近交流】\n${ownTail.map((e) => e.text).join("\n\n")}`);
  }

  const teamTail = team.slice(-opts.teamEntries);
  if (teamTail.length) {
    sections.push(`【队友最近动态】\n${teamTail.map((e) => e.text).join("\n\n")}`);
  }

  return sections;
}
