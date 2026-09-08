/**
 * LLM 适配层 — 直接调 API，不经过 OpenClaw Gateway
 * 支持 Google Gemini / OpenAI / Anthropic / 国内兼容模型
 */

/**
 * Gemini API key 从环境变量读取（server.ts 里的 dotenv.config() 负责加载 .env）。
 *
 * 必须延迟到调用时再读，不能做成模块级常量：本模块被 server.ts 在顶层
 * import，ESM 会先执行本模块体，再执行 server.ts 里的 dotenv.config()，
 * 模块级常量那一刻还取不到值。
 */
function geminiApiKey(): string {
  const key = (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "").trim();
  if (!key) {
    throw new Error(
      "缺少 GEMINI_API_KEY：请在项目根目录 .env 中配置（格式见 .env.example）"
    );
  }
  return key;
}

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/openai";
const DEFAULT_MODEL = "gemini-3-flash-preview";

// ── Token 用量统计 ──────────────────────────────────────────────────
const tokenStats = {
  prompt: 0,
  completion: 0,
  total: 0,
  calls: 0,
  startedAt: new Date().toISOString(),
};

export function getTokenStats() {
  return { ...tokenStats };
}

export function resetTokenStats() {
  tokenStats.prompt = 0;
  tokenStats.completion = 0;
  tokenStats.total = 0;
  tokenStats.calls = 0;
  tokenStats.startedAt = new Date().toISOString();
}

function trackUsage(usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }) {
  if (!usage) return;
  tokenStats.prompt += usage.prompt_tokens || 0;
  tokenStats.completion += usage.completion_tokens || 0;
  tokenStats.total += usage.total_tokens || 0;
  tokenStats.calls += 1;
}

/**
 * 消息内容。
 *
 * 多数场景是纯文本，但视觉兜底要把截图发给模型（网申表单里有些控件没有任何
 * 无障碍信息、DOM 也驱动不了，只能看图点坐标）。Gemini 的 OpenAI 兼容端点接受
 * 分段内容，图片走 data: URL。
 */
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string | ContentPart[];
  name?: string;
};

export type ChatCompletionOptions = {
  model?: string;
  messages: ChatMessage[];
  max_tokens?: number;
  stream?: boolean;
  signal?: AbortSignal;
  reasoning_effort?: "minimal" | "low" | "medium" | "high";
};

export type ChatCompletionResult = {
  content: string;
  model: string;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
};

/**
 * 解析 model 字符串，返回实际的 API base URL / key / model id
 * 支持格式：
 *   "auto"                      → 默认 Gemini Flash
 *   "gemini-3-flash-preview"    → Gemini
 *   "google/gemini-3-flash-preview" → Gemini
 *   "openclaw:agent-id"         → 忽略 agent 前缀，用默认模型
 */
function resolveModel(model?: string): { baseUrl: string; apiKey: string; modelId: string } {
  const raw = (model || "auto").trim();

  // 兼容旧格式
  if (raw.startsWith("openclaw:")) {
    return { baseUrl: GEMINI_BASE, apiKey: geminiApiKey(), modelId: DEFAULT_MODEL };
  }

  // "auto" 或空
  if (raw === "auto" || !raw) {
    return { baseUrl: GEMINI_BASE, apiKey: geminiApiKey(), modelId: DEFAULT_MODEL };
  }

  // 去掉 provider 前缀
  const modelId = raw.includes("/") ? raw.split("/").slice(1).join("/") : raw;

  // 根据模型名判断 provider
  if (modelId.startsWith("gemini")) {
    return { baseUrl: GEMINI_BASE, apiKey: geminiApiKey(), modelId };
  }

  // 默认走 Gemini
  return { baseUrl: GEMINI_BASE, apiKey: geminiApiKey(), modelId: DEFAULT_MODEL };
}

/**
 * 非流式 chat completion
 */
export async function chatCompletion(options: ChatCompletionOptions): Promise<ChatCompletionResult> {
  const { baseUrl, apiKey, modelId } = resolveModel(options.model);

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: modelId,
      messages: options.messages,
      ...(options.max_tokens ? { max_tokens: options.max_tokens } : {}),
      ...(options.reasoning_effort ? { reasoning_effort: options.reasoning_effort } : {}),
    }),
    ...(options.signal ? { signal: options.signal } : {}),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`LLM API error ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = await res.json() as any;
  const content = data.choices?.[0]?.message?.content || "";
  trackUsage(data.usage);

  return {
    content,
    model: modelId,
    usage: data.usage,
  };
}

/**
 * 流式 chat completion — 返回 Response 对象，调用方自行处理 stream
 */
export async function chatCompletionStream(options: ChatCompletionOptions): Promise<Response> {
  const { baseUrl, apiKey, modelId } = resolveModel(options.model);

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: modelId,
      messages: options.messages,
      stream: true,
      ...(options.max_tokens ? { max_tokens: options.max_tokens } : {}),
    }),
    ...(options.signal ? { signal: options.signal } : {}),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`LLM API stream error ${res.status}: ${text.slice(0, 200)}`);
  }

  tokenStats.calls += 1; // 流式调用也记录次数

  return res;
}

/**
 * 快捷方法：提取 JSON
 */
/**
 * 带一张图问模型要 JSON。
 *
 * 视觉兜底专用：截图 + 目标框 → 模型给出该点哪里。返回的坐标由 vision-click.ts
 * 校验必须落在目标框内——坐标是危险输出，点歪了可能点到「提交」。
 */
export async function chatExtractJsonWithImage<T = any>(
  systemPrompt: string,
  userContent: string,
  imageDataUrl: string,
  options?: { max_tokens?: number; signal?: AbortSignal; reasoning_effort?: ChatCompletionOptions["reasoning_effort"] }
): Promise<T | null> {
  const result = await chatCompletion({
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: [
        { type: "text", text: userContent },
        { type: "image_url", image_url: { url: imageDataUrl } },
      ] },
    ],
    max_tokens: options?.max_tokens || 300,
    reasoning_effort: options?.reasoning_effort,
    signal: options?.signal,
  });
  const match = result.content.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]) as T;
  } catch {
    return null;
  }
}

export async function chatExtractJson<T = any>(
  systemPrompt: string,
  userContent: string,
  options?: { max_tokens?: number; signal?: AbortSignal; reasoning_effort?: ChatCompletionOptions["reasoning_effort"] }
): Promise<T | null> {
  const result = await chatCompletion({
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userContent },
    ],
    max_tokens: options?.max_tokens || 300,
    // 推理 token 也算进 max_tokens：抽取类任务推理花掉预算就没有 content 了。
    // 真机上网申取值 3 个字段时推理占 1135 token 还能输出，8 个字段就吃光 2000
    // 的预算、content 返回空——表现为「时好时坏」。
    reasoning_effort: options?.reasoning_effort,
    signal: options?.signal,
  });

  const match = result.content.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]) as T;
  } catch {
    return null;
  }
}
