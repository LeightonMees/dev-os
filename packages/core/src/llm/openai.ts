// Minimal OpenAI-compatible chat client. Groq, Cerebras, OpenRouter, GitHub
// Models, Gemini (openai endpoint), NVIDIA, Mistral, Z.ai and Ollama all speak
// this shape. No SDK: one fetch, explicit types, tool calls passed through.

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ToolDefinition {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ChatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

export interface ChatResult {
  message: ChatMessage;
  finishReason: string | null;
  usage: ChatUsage | null;
  model: string | null;
}

export interface ChatOptions {
  baseUrl: string;
  apiKey: string | null;
  model: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  temperature?: number;
  /**
   * OpenAI-compatible reasoning dial. Only sent when set: a gateway that does not know the field
   * would reject the whole request, so an unset dial must not put it in the body.
   */
  reasoningEffort?: string | null;
  maxTokens?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  extraHeaders?: Record<string, string>;
}

export async function chatCompletion(options: ChatOptions): Promise<ChatResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 120_000);
  const onAbort = () => controller.abort();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const body: Record<string, unknown> = {
      model: options.model,
      messages: options.messages,
      temperature: options.temperature ?? 0.2,
    };
    if (options.maxTokens) body.max_tokens = options.maxTokens;
    if (options.reasoningEffort) body.reasoning_effort = options.reasoningEffort;
    if (options.tools && options.tools.length > 0) {
      body.tools = options.tools;
      body.tool_choice = "auto";
    }
    const response = await fetch(`${options.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
        ...(options.extraHeaders ?? {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${response.status} from ${options.baseUrl}: ${text.slice(0, 400)}`);
    const parsed = JSON.parse(text) as { choices?: { message: ChatMessage; finish_reason?: string }[]; usage?: ChatUsage; model?: string };
    const choice = parsed.choices?.[0];
    if (!choice) throw new Error(`No choices in response from ${options.baseUrl}`);
    return { message: choice.message, finishReason: choice.finish_reason ?? null, usage: parsed.usage ?? null, model: parsed.model ?? null };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

/** Cheap reachability probe: GET /models. 401 means the endpoint is up but the key is wrong. */
export async function probeModels(baseUrl: string, apiKey: string | null, timeoutMs = 8000): Promise<{ ok: boolean; detail: string; count?: number }> {
  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/models`, {
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status === 401 || response.status === 403) return { ok: false, detail: `key rejected (${response.status})` };
    if (!response.ok) return { ok: false, detail: `${response.status} from /models` };
    const body = (await response.json().catch(() => ({}))) as { data?: unknown[]; models?: unknown[] };
    const count = Array.isArray(body.data) ? body.data.length : Array.isArray(body.models) ? body.models.length : undefined;
    return { ok: true, detail: count !== undefined ? `${count} models listed` : "endpoint reachable", count };
  } catch (error) {
    return { ok: false, detail: `unreachable: ${(error as Error).message}` };
  }
}

export function parseToolArguments(call: ToolCall): Record<string, unknown> {
  try {
    const parsed = JSON.parse(call.function.arguments || "{}");
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
