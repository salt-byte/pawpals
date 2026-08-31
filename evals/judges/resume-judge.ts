import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const RUBRIC_PATH = path.join(__dirname, "..", "rubrics", "resume-expert.md");

const RESUME_AGENT_SYSTEM = `你是简历专家。基于用户档案和 JD，给出针对性的简历改写建议。

要求：
- 引用 JD 至少 2 个具体技能/关键词
- 给出可直接 copy 的改写文本（具体句子，不要"建议突出"这种空话）
- 覆盖用户档案里标注的薄弱项
- 控制在 400 字以内`;

export type ResumeCase = {
  id: string;
  profile: string;
  jd: string;
  userMsg: string;
};

type ChatFn = (opts: any) => Promise<{ content: string }>;

async function generateResumeAdvice(c: ResumeCase, chat: ChatFn): Promise<string> {
  const result = await chat({
    messages: [
      { role: "system", content: RESUME_AGENT_SYSTEM },
      { role: "user", content: `【用户档案】\n${c.profile}\n\n【JD】\n${c.jd}\n\n【请求】\n${c.userMsg}` },
    ],
    max_tokens: 3000,
    reasoning_effort: "low",
  } as any);
  return result.content || "";
}

async function judgeResume(c: ResumeCase, advice: string, chat: ChatFn): Promise<any> {
  const rubric = readFileSync(RUBRIC_PATH, "utf8");
  const sys = `你是质检员，严格按 rubric 给简历建议打分。只输出 JSON。

【Rubric】
${rubric}

打分要求：
- rubric 每项给 0 或 1
- score = 命中项 / 总项数
- passed = score >= 0.75
- issues 写明哪几项 = 0 以及原因`;

  const user = `【用户档案】\n${c.profile}\n\n【JD】\n${c.jd}\n\n【简历建议】\n${advice}\n\n只输出 JSON。`;
  const result = await chat({
    messages: [{ role: "system", content: sys }, { role: "user", content: user }],
    max_tokens: 4000,
    reasoning_effort: "low",
  });
  const parsed = parseJudgeJson(result.content);
  if (parsed.issues?.[0] === "judge JSON 解析失败") {
    console.log(`\n[debug] raw judge output (${result.content.length} chars):\n${result.content}\n`);
  }
  return parsed;
}

function parseJudgeJson(raw: string): any {
  let s = (raw || "").trim();
  s = s.replace(/^```json\s*/i, "").replace(/^```\s*/, "").replace(/```\s*$/, "").trim();
  try { return JSON.parse(s); } catch {}
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try { return JSON.parse(s.slice(start, end + 1)); } catch {}
  }
  return { passed: false, score: 0, rubric: {}, issues: ["judge JSON 解析失败"], raw_preview: raw.slice(0, 300) };
}

export async function runResumeSuite(cases: ResumeCase[], chat: ChatFn) {
  const results: any[] = [];
  let totalScore = 0;
  let passed = 0;
  for (const c of cases) {
    process.stdout.write(`  ${c.id} … `);
    const advice = await generateResumeAdvice(c, chat);
    const review = await judgeResume(c, advice, chat);
    results.push({ id: c.id, advice_preview: advice.slice(0, 200), review });
    totalScore += review.score || 0;
    if (review.passed) passed += 1;
    console.log(`score=${(review.score ?? 0).toFixed(2)} ${review.passed ? "✓" : "✗"}`);
  }
  const n = cases.length;
  return {
    suite: "resume",
    n,
    summary: {
      avg_score: n > 0 ? Number((totalScore / n).toFixed(3)) : 0,
      pass_rate: n > 0 ? Number((passed / n).toFixed(3)) : 0,
      passed,
      failed: n - passed,
    },
    results,
  };
}
