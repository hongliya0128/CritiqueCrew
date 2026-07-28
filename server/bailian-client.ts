import { z } from "zod";
import type { ServerConfig } from "./config";

export const DEFAULT_REQUEST_TIMEOUT_MS = 45_000;

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type CompletionRequest = {
  messages: ChatMessage[];
  model?: string;
  jsonMode?: boolean;
};

export type CompletionResult = {
  id: string;
  model: string;
  content: string;
  latencyMs: number;
  mock: boolean;
  usage: {
    promptTokens: number | null;
    completionTokens: number | null;
    totalTokens: number | null;
  };
};

type FetchLike = typeof fetch;

const responseSchema = z.object({
  id: z.string().min(1),
  model: z.string().min(1),
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.string().min(1),
        }),
      }),
    )
    .min(1),
  usage: z
    .object({
      prompt_tokens: z.number().int().nonnegative().optional(),
      completion_tokens: z.number().int().nonnegative().optional(),
      total_tokens: z.number().int().nonnegative().optional(),
    })
    .optional(),
});

function sanitizedMessage(value: string, secret: string): string {
  const withoutSecret = secret ? value.replaceAll(secret, "[redacted]") : value;
  return withoutSecret.slice(0, 500);
}

export class BailianClient {
  constructor(
    private readonly config: ServerConfig,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ) {}

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const model = request.model ?? this.config.model;
    const startedAt = Date.now();

    if (this.config.mockMode) {
      return {
        id: "mock-completion",
        model,
        content: JSON.stringify({ status: "ok", message: "CritiqueCrew Mock 模型连接正常" }),
        latencyMs: Date.now() - startedAt,
        mock: true,
        usage: { promptTokens: null, completionTokens: null, totalTokens: null },
      };
    }

    if (!this.config.apiKey) {
      throw new Error("DASHSCOPE_API_KEY 未配置，请在本地 .env 中填写按量付费 API Key。");
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(`${this.config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages: request.messages,
          enable_thinking: false,
          ...(request.jsonMode ? { response_format: { type: "json_object" } } : {}),
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const details = sanitizedMessage(await response.text(), this.config.apiKey);
        throw new Error(
          `百炼请求失败（HTTP ${response.status}）${details ? `：${details}` : ""}`,
        );
      }

      const parsed = responseSchema.safeParse(await response.json());
      if (!parsed.success) {
        throw new Error("百炼响应格式无效：choices 必须是非空数组，且消息内容不能为空。");
      }

      const usage = parsed.data.usage;
      return {
        id: parsed.data.id,
        model: parsed.data.model,
        content: parsed.data.choices[0].message.content,
        latencyMs: Date.now() - startedAt,
        mock: false,
        usage: {
          promptTokens: usage?.prompt_tokens ?? null,
          completionTokens: usage?.completion_tokens ?? null,
          totalTokens: usage?.total_tokens ?? null,
        },
      };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`百炼请求超时（${Math.round(this.timeoutMs / 1000)} 秒）。`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}
