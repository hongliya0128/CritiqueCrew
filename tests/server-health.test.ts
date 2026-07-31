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

describe("POST /api/review", () => {
  it("returns the three Mock role reviews", async () => {
    const response = await request(createApp(config)).post("/api/review").send({
      scan: { scope: "selection", rootId: "root", rootName: "Root", rootType: "FRAME", nodeCount: 0, truncated: false, nodes: [] },
      rules: { issues: [], skippedContrastNodes: 0, score: null, scoreItems: [] },
    }).expect(200);

    expect(response.body.mock).toBe(true);
    expect(response.body.reviews).toHaveLength(3);
    expect(response.body.reviews.map((review: { role: string }) => review.role)).toEqual(["visual", "accessibility", "interaction"]);
  });
});
