// Routing 测试：纯本地（不过 LLM），复刻 server.ts 里的 detectTargetAgent 逻辑
// 这样能精确测出"@/alias/默认兜底"的路由准确率

const AGENT_IDS = [
  "career-planner", "professional-teacher", "resume-expert",
  "job-hunter", "app-tracker", "networker", "interview-coach",
];

const NAME_TO_ID: Record<string, string> = {
  "首席伴学官": "career-planner",
  "团团": "career-planner",
  "专业老师": "professional-teacher",
  "技能分析师": "professional-teacher",
  "技能成长师": "professional-teacher",
  "JD分析师": "professional-teacher",
  "简历专家": "resume-expert",
  "岗位猎手": "job-hunter",
  "投递管家": "app-tracker",
  "人脉顾问": "networker",
  "面试教练": "interview-coach",
};

function detectTargetAgent(text: string): string {
  // 1. 引用回复格式
  const replyMatch = text.match(/回复\s+\*{0,2}([一-龥A-Za-z\d-]+)\*{0,2}[：:]/);
  if (replyMatch) {
    const id = NAME_TO_ID[replyMatch[1]] || (AGENT_IDS.includes(replyMatch[1]) ? replyMatch[1] : null);
    if (id) return id;
  }
  // 2. @ 中文名
  for (const [name, id] of Object.entries(NAME_TO_ID)) {
    if (text.includes("@" + name)) return id;
  }
  // 3. @ 英文 id
  for (const id of AGENT_IDS) {
    if (text.includes("@" + id)) return id;
  }
  // 4. 默认兜底
  return "career-planner";
}

export type RoutingCase = { id: string; userMsg: string; expected: string; reason?: string };

export async function runRoutingSuite(cases: RoutingCase[]) {
  const results: any[] = [];
  let passed = 0;
  for (const c of cases) {
    const actual = detectTargetAgent(c.userMsg);
    const ok = actual === c.expected;
    if (ok) passed += 1;
    results.push({
      id: c.id,
      userMsg: c.userMsg,
      expected: c.expected,
      actual,
      passed: ok,
      reason: c.reason,
    });
    console.log(`${ok ? "✓" : "✗"} ${c.id}  expected=${c.expected}  actual=${actual}`);
  }
  const accuracy = cases.length > 0 ? passed / cases.length : 0;
  return {
    suite: "routing",
    n: cases.length,
    summary: {
      accuracy: Number(accuracy.toFixed(3)),
      passed,
      failed: cases.length - passed,
    },
    results,
  };
}
