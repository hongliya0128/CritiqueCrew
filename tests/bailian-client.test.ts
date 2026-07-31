import { describe, expect, it, vi } from "vitest";
import { BailianClient } from "../server/bailian-client";
import type { ServerConfig } from "../server/config";

function config(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    provider: "bailian",
    apiKey: "test-secret-key",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "qwen3.7-plus",
    port: 8787,
    mockMode: false,
    ...overrides,
  };
}

describe("BailianClient", () => {
  it("returns deterministic data without a network request in Mock mode", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const client = new BailianClient(config({ mockMode: true, apiKey: "" }), fetchMock);

    const result = await client.complete({
      messages: [{ role: "user", content: "Return JSON" }],
      jsonMode: true,
    });

    expect(result.mock).toBe(true);
    expect(result.model).toBe("qwen3.7-plus");
    expect(JSON.parse(result.content)).toMatchObject({ status: "ok" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends a non-thinking JSON Mode request and validates the response", async () => {
    let requestBody: Record<string, unknown> | undefined;
    const fetchMock: typeof fetch = async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          id: "chatcmpl-test",
          model: "qwen3.7-plus",
          choices: [{ message: { content: '{"status":"ok"}' } }],
          usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };
    const client = new BailianClient(config(), fetchMock);

    const result = await client.complete({
      messages: [{ role: "user", content: "Return JSON" }],
      jsonMode: true,
    });

    expect(requestBody).toMatchObject({
      model: "qwen3.7-plus",
      enable_thinking: false,
      response_format: { type: "json_object" },
    });
    expect(result.mock).toBe(false);
    expect(result.usage.totalTokens).toBe(12);
    expect(JSON.parse(result.content)).toEqual({ status: "ok" });
  });

  it("rejects HTTP 200 responses with empty choices", async () => {
    const fetchMock: typeof fetch = async () =>
      new Response(
        JSON.stringify({ id: "bad-response", model: "qwen3.7-plus", choices: [] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    const client = new BailianClient(config(), fetchMock);

    await expect(
      client.complete({ messages: [{ role: "user", content: "Return JSON" }] }),
    ).rejects.toThrow("choices 必须是非空数组");
  });

  it("retries one time after a 429 response", async () => {
    let calls = 0;
    const fetchMock: typeof fetch = async () => {
      calls += 1;
      if (calls === 1) return new Response("rate limited", { status: 429 });
      return new Response(
        JSON.stringify({
          id: "chatcmpl-retry",
          model: "qwen3.7-plus",
          choices: [{ message: { content: '{"status":"ok"}' } }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };
    const client = new BailianClient(config(), fetchMock);

    const result = await client.complete({
      messages: [{ role: "user", content: "Return JSON" }],
      jsonMode: true,
    });

    expect(calls).toBe(2);
    expect(JSON.parse(result.content)).toEqual({ status: "ok" });
  });
});
