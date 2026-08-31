import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const RUBRIC_PATH = path.join(__dirname, "..", "rubrics", "interview-coach.md");

const COACH_SYSTEM = `你是面试教练。针对用户的回答，输出：
1. score（0-10）
2. strengths（每条引用用户原话）
3. weaknesses（每条配示范改法）
4. 如用户没用 STAR 结构，明确指出并示范
控制在 300 字以内。`;

export type InterviewCase = {
  id: string;
  role: string;
  question: string;
  answer: string;
};

type ChatFn = (opts: any) => Promise<{ content: string }>;

async function generateCoachFeedback(c: InterviewCase, chat: ChatFn): Promise<string> {
  const result = await chat({
    messages: [
      { role: "system", content: COACH_SYSTEM },
      { role: "user", content: `岗位：${c.role}\n问题：${c.question}\n候选人回答：${c.answer}` },
    ],
    max_tokens: 3000,
    reasoning_effort: "low",
  } as any);
  return result.content || "";
}

async function judgeFeedback(c: InterviewCase, feedback: string, chat: ChatFn): Promise<any> {
  const rubric = readFileSync(RUBRIC_PATH, "utf8");
  const sys = `你是质检员，按 rubric 给面试教练的点评打分。只输出 JSON。

【Rubric】
${rubric}

打分要求同上：每项 0/1，score 平均，passed = score >= 0.75。`;

  const user = `【岗位】${c.role}\n【问题】${c.question}\n【候选人答】${c.answer}\n【教练点评】\n${feedback}\n\n只输出 JSON。`;
  const result = await chat({
    messages: [{ role: "system", content: sys }, { role: "user", content: user }],
    max_tokens: 4000,
    reasoning_effort: "low",
  });
  return parseJudgeJson(result.content);
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

export async function runInterviewSuite(cases: InterviewCase[], chat: ChatFn) {
  const results: any[] = [];
  let totalScore = 0;
  let passed = 0;
  for (const c of cases) {
    process.stdout.write(`  ${c.id} … `);
    const feedback = await generateCoachFeedback(c, chat);
    const review = await judgeFeedback(c, feedback, chat);
    results.push({ id: c.id, feedback_preview: feedback.slice(0, 200), review });
    totalScore += review.score || 0;
    if (review.passed) passed += 1;
    console.log(`score=${(review.score ?? 0).toFixed(2)} ${review.passed ? "✓" : "✗"}`);
  }
  const n = cases.length;
  return {
    suite: "interview",
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
