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
  it("returns a readable JSON error for an invalid request", async () => {
    const response = await request(createApp(config)).post("/api/review").send({ scan: {} }).expect(400);

    expect(response.type).toBe("application/json");
    expect(response.body).toEqual({ error: "Invalid review request." });
  });

  it("uses the same JSON error format when the request body cannot be parsed", async () => {
    const response = await request(createApp(config))
      .post("/api/review")
      .set("Content-Type", "application/json")
      .send('{"scan":')
      .expect(400);

    expect(response.type).toBe("application/json");
    expect(response.body).toEqual({ error: "评审请求格式无效，请重新扫描后再试。" });
  });

  it("returns the three Mock role reviews", async () => {
    const response = await request(createApp(config)).post("/api/review").send({
      scan: { scope: "selection", rootId: "root", rootName: "Root", rootType: "FRAME", nodeCount: 0, truncated: false, nodes: [] },
      rules: { issues: [], skippedContrastNodes: 0 },
    }).expect(200);

    expect(response.body.mock).toBe(true);
    expect(response.body.reviews).toHaveLength(3);
    expect(response.body.reviews.map((review: { role: string }) => review.role)).toEqual(["visual", "accessibility", "interaction"]);
  });

  it("returns a detected direction conflict, coordinated tradeoff, and composite score", async () => {
    const response = await request(createApp(config)).post("/api/review").send({
      scan: {
        scope: "selection",
        rootId: "frame-1",
        rootName: "测试页面",
        rootType: "FRAME",
        nodeCount: 1,
        truncated: false,
        nodes: [{ id: "button-1", name: "主要按钮", type: "FRAME", hasPointerInteraction: true }],
      },
      rules: { issues: [], skippedContrastNodes: 0 },
    }).expect(200);

    expect(response.body.coordination.status).toBe("completed");
    expect(response.body.coordination.conflicts).toHaveLength(1);
    expect(response.body.coordination.conflicts[0].issues.map((item: { direction: string }) => item.direction)).toEqual([
      "weaken",
      "strengthen",
    ]);
    expect(response.body.coordination.tradeoffs).toHaveLength(1);
    expect(response.body.coordination.overallSummary).not.toBe("");
    expect(response.body.compositeScore).toMatchObject({ score: 79, incomplete: false });
    expect(response.body.incomplete).toBe(false);
  });
});
