import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../server/app";
import type { ServerConfig } from "../server/config";

const config: ServerConfig = {
  provider: "bailian",
  apiKey: "must-not-appear-in-response",
  baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  model: "qwen3.7-plus",
  port: 8787,
  mockMode: true,
};

describe("GET /health", () => {
  it("returns safe proxy status without exposing the API key", async () => {
    const response = await request(createApp(config)).get("/health").expect(200);

    expect(response.body).toEqual({
      status: "ok",
      provider: "bailian",
      model: "qwen3.7-plus",
      apiKeyConfigured: true,
      mockMode: true,
    });
    expect(JSON.stringify(response.body)).not.toContain(config.apiKey);
  });
});
