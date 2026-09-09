/**
 * 用户信息的结构化知识库。
 *
 * ── 为什么需要它 ──
 * 信息原本散在三处：全局 CLAUDE.md（学历/专业/经历）、resume_master.md（手写摘录）、
 * 用户脑子里（民族/学号/出差意向）。而填表只读第二处——真机实测 resume_master.md 里
 * 「学位」「毕业时间」「出生年月」「民族」「学号」「籍贯」的出现次数**全是 0**。
 *
 * 后果是这些字段模型从头到尾都在猜：同一个「学位」在不同轮次填成过工学、管理学、
 * 文学，而候选人读的是传播/数据科学，三个都不对。这类错误闸门拦不住——值在选项列表
 * 里、来源在档案里，两道校验都过。
 *
 * ── 为什么是结构化而不是向量检索 ──
 * 表单要的字段是**有限且已知**的：姓名、民族、学号、学校、专业、学位、毕业时间、
 * 成绩排名……。对这种查询，精确的键值查找比相似度检索可靠得多——检索会「差不多命中」，
 * 而填表要的是「就是这个」。向量检索的用武之地在别处（面经原文、JD 全文那种非结构化
 * 且查询事先不知道的语料）。
 *
 * ── 它真正的价值 ──
 * 不在「检索」，在**「已知的字段永远不经过模型」**：查得到就直接填，连猜的机会都不给；
 * 查不到就如实说不知道，去问用户。
 */
export type ProfileFacts = Record<string, string>;

/** 小节名 → 表单里常用的说法。用来把「本科专业」对到「本科·专业」。 */
const SECTION_ALIASES: Record<string, string[]> = {
  本科: ["本科", "学士", "大学本科"],
  硕士: ["硕士", "研究生"],
  博士: ["博士"],
};

const tidy = (text: unknown) => String(text ?? "").replace(/\s+/g, " ").trim();

/**
 * 占位符：档案里标记「还没问到」用的。
 *
 * 必须当成查不到——否则雇主的表单里会出现「民族：待确认」，比空着糟得多：
 * 空着人家会问，填了这个是当场露怯。
 */
const PLACEHOLDER = /^(待确认|待补充|待填|未知|不详|TBD|N\/A|-|—)/i;

/**
 * 把 markdown 档案解析成扁平键值。
 *
 * 三级标题（### 本科 · 北京电影学院）里的字段会带上小节前缀（本科·专业），因为
 * 本科和硕士都有「专业」「毕业时间」「成绩排名」——不带前缀会互相覆盖，而表单
 * 恰恰要分开填。
 */
export function parseProfile(markdown: string): ProfileFacts {
  const out: ProfileFacts = {};
  let section = "";
  for (const raw of String(markdown || "").split("\n")) {
    const line = raw.trim();
    const heading = line.match(/^###\s+(.+)$/);
    if (heading) {
      // 「本科 · 北京电影学院」→ 前缀取「本科」
      section = tidy(heading[1].split(/[·•|]/)[0]);
      continue;
    }
    if (/^##\s+/.test(line)) { section = ""; continue; }
    const field = line.match(/^[-*]\s*([^:：]+)\s*[:：]\s*(.+)$/);
    if (!field) continue;
    const key = tidy(field[1]);
    const value = tidy(field[2]);
    if (!key || !value) continue;
    // 都取第一个：用户有两个硕士（清华、USC），后写的盖掉先写的之后，「研究生
    // 学校」会查出 USC——而国内表单的下拉里只有国内高校。档案里把主修/国内那个
    // 写在前面，这个约定比「按学校名猜哪个对」可靠。
    out[key] = out[key] ?? value;
    if (section) {
      const scoped = `${section}·${key}`;
      out[scoped] = out[scoped] ?? value;
    }
  }
  return out;
}

/**
 * 按表单的字段名查。查得到返回值和出处，查不到返回 null——**不猜、不近似**。
 *
 * 出处是给反编造闸门用的：闸门要求引用能在档案原文里逐字找到，所以这里回一段
 * 「民族: 汉族」这样的原文片段。
 */
export function lookupField(facts: ProfileFacts, label: string): { value: string; source: string } | null {
  const name = tidy(label);
  if (!name) return null;

  const hit = (key: string) => {
    const value = facts[key];
    // 占位符当作没有答案：它是「还没问到」的标记，不是值
    if (!value || PLACEHOLDER.test(value)) return null;
    return { value, source: `${key.split("·").pop()}: ${value}` };
  };

  // 1) 直接命中：民族、姓名、出差意向……
  const direct = hit(name);
  if (direct) return direct;

  // 2) 带学段前缀的：本科专业 → 本科·专业，研究生毕业时间 → 硕士·毕业时间
  for (const [section, aliases] of Object.entries(SECTION_ALIASES)) {
    for (const alias of aliases) {
      if (!name.startsWith(alias)) continue;
      const rest = name.slice(alias.length).trim();
      if (!rest) continue;
      const found = hit(`${section}·${rest}`);
      if (found) return found;
    }
  }

  return null;
}

/** 这些字段里，档案还答不上来的是哪些。 */
export function missingFields(facts: ProfileFacts, labels: string[]): string[] {
  return (labels ?? []).filter((label) => !lookupField(facts, label));
}
