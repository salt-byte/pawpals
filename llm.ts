import { traced } from "./server/tracing.ts";

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

type Usage = { prompt_tokens: number; completion_tokens: number; total_tokens: number };

/**
 * 用量钩子。llm.ts 不知道用户是谁——由 server.ts 挂一个从异步上下文取用户的
 * 函数进来。钩子抛错不能影响模型调用，所以 try/catch。
 */
let usageHook: ((usage: Usage) => void) | null = null;
export function setUsageHook(fn: ((usage: Usage) => void) | null) {
  usageHook = fn;
}

function trackUsage(usage?: Usage) {
  if (!usage) return;
  tokenStats.prompt += usage.prompt_tokens || 0;
  tokenStats.completion += usage.completion_tokens || 0;
  tokenStats.total += usage.total_tokens || 0;
  tokenStats.calls += 1;
  try { usageHook?.(usage); } catch (e: any) { console.warn("[llm] usage hook 抛错：", e?.message || e); }
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

/** 交给模型的工具声明（OpenAI 兼容格式）。 */
export type ToolDefinition = {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
};

export type ChatCompletionOptions = {
  model?: string;
  messages: ChatMessage[];
  /**
   * 可选的工具表。之前这里完全没有——工具全靠正则匹配用户消息来触发，模型从头
   * 到尾没选过工具。声明了工具，模型才可能自己决定调哪个。
   *
   * 注意提交类动作永远不该出现在这里：模型看不见，也就选不了（见 tool-loop.ts）。
   */
  tools?: ToolDefinition[];
  max_tokens?: number;
  stream?: boolean;
  signal?: AbortSignal;
  reasoning_effort?: "minimal" | "low" | "medium" | "high";
};

export type ChatCompletionResult = {
  content: string;
  /**
   * 模型选了哪些工具。声明了 tools 才可能有。
   *
   * 形状对齐 OpenAI 兼容格式，但参数已经解析成对象——原始返回里 arguments 是
   * 一段 JSON 字符串，模型偶尔会写出解析不了的东西，那种情况当成没选工具处理，
   * 不让一次坏输出把整轮打断。
   */
  toolCalls?: Array<{
    id: string;
    name: string;
    args: Record<string, unknown>;
    /**
     * 服务端返回的**原始**工具调用对象，原样保留。
     *
     * 回放到对话历史时必须用它，不能拿 id/name/args 重新拼一个：Gemini 会在
     * extra_content.google.thought_signature 里塞一段不透明签名，少了它第二轮
     * 直接 400「Function call is missing a thought_signature」。这类字段是
     * provider 特有的，今天没有的明天也可能有——所以原样留着，别自作聪明。
     */
    raw: unknown;
  }>;
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
async function chatCompletionInner(options: ChatCompletionOptions): Promise<ChatCompletionResult> {
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
      ...(options.tools?.length ? { tools: options.tools } : {}),
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
  const rawCalls = data.choices?.[0]?.message?.tool_calls;
  const toolCalls = Array.isArray(rawCalls)
    ? rawCalls
        .map((call: any) => {
          // arguments 是模型写出来的 JSON 字符串，解析不了就丢掉这一条：
          // 一次坏输出不该打断整轮，上层会看到「没选工具」并继续。
          let args: Record<string, unknown> = {};
          try {
            args = call?.function?.arguments ? JSON.parse(call.function.arguments) : {};
          } catch {
            return null;
          }
          const name = String(call?.function?.name || "");
          return name ? { id: String(call?.id || name), name, args, raw: call } : null;
        })
        .filter(Boolean)
    : undefined;
  trackUsage(data.usage);

  return {
    content,
    ...(toolCalls?.length ? { toolCalls: toolCalls as any } : {}),
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

/**
 * 每次模型调用都留痕（未开启追踪时原样透传，见 server/tracing.ts）。
 *
 * 这是最底下那一层：完整的 prompt、模型的原始输出、token 用量、耗时。今天调
 * 「模型为什么放弃这个字段」时缺的正是它——只看得到结果，看不到它到底看见了什么。
 */
export const chatCompletion = traced("llm.chat", chatCompletionInner);
