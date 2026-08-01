import { describe, expect, it } from "vitest";
import { buildReviewMessages, ROLE_DESIGNS, ReviewService } from "../server/review-service";
import type { BailianClient, CompletionRequest, CompletionResult } from "../server/bailian-client";
import type { ServerConfig } from "../server/config";
import type { ReviewRequest } from "../src/shared/review";

const config: ServerConfig = {
  provider: "bailian", apiKey: "", baseUrl: "https://example.test/v1", model: "test-model", port: 8787, mockMode: true,
};

const reviewRequest: ReviewRequest = {
  scan: {
    scope: "selection", rootId: "frame-1", rootName: "Test frame", rootType: "FRAME", nodeCount: 2, truncated: false,
    nodes: [
      { id: "text-1", parentId: "frame-1", childIds: [], name: "Small copy", type: "TEXT", depth: 1, visible: true, locked: false, x: 0, y: 0, absoluteX: 0, absoluteY: 0, width: 120, height: 20, rotation: 0, opacity: 1, fills: [], fillKind: "none", hasPointerInteraction: false, fontSize: 12, characters: "Hello", cornerRadius: null },
      { id: "nav-1", parentId: "frame-1", childIds: [], name: "Bottom navigation", type: "FRAME", depth: 1, visible: true, locked: false, x: 0, y: 200, absoluteX: 0, absoluteY: 200, width: 320, height: 40, rotation: 0, opacity: 1, fills: [], fillKind: "none", hasPointerInteraction: true, fontSize: null, characters: null, cornerRadius: 12 },
    ],
  },
  rules: { issues: [{ id: "font-size:text-1", ruleId: "font-size", severity: "error", nodeId: "text-1", nodeName: "Small copy", nodeType: "TEXT", message: "Text is too small", actual: "12px", expected: "14px" }], skippedContrastNodes: 0 },
};

describe("ReviewService", () => {
  it("returns three independent role reviews in Mock mode", async () => {
    const response = await new ReviewService(config).review(reviewRequest);

    expect(response.mock).toBe(true);
    expect(response.incomplete).toBe(false);
    expect(response.reviews.map((review) => review.role)).toEqual(["visual", "accessibility", "interaction"]);
    expect(response.reviews.every((review) => review.status === "completed")).toBe(true);
    expect(response.reviews.find((review) => review.role === "accessibility")?.issues[0]?.nodeId).toBe("text-1");
    expect(response.arbitration.status).toBe("completed");
    expect(response.arbitration.conflicts).toHaveLength(1);
    expect(response.arbitration.decisions).toHaveLength(1);
    expect(response.compositeScore.score).toBe(73);
  });

  it("builds genuinely distinct role prompts and only gives detailed rule signals to accessibility", () => {
    const visualMessages = buildReviewMessages("visual", reviewRequest);
    const visual = JSON.stringify(visualMessages);
    const accessibility = JSON.stringify(buildReviewMessages("accessibility", reviewRequest));
    const interaction = JSON.stringify(buildReviewMessages("interaction", reviewRequest));
    const visualInput = visualMessages[1].content;

    expect(ROLE_DESIGNS.visual.systemPrompt).toContain("视觉节奏");
    expect(ROLE_DESIGNS.accessibility.systemPrompt).toContain("语义层问题");
    expect(ROLE_DESIGNS.interaction.systemPrompt).toContain("误操作风险");
    expect(ROLE_DESIGNS.visual.systemPrompt).toContain("识别页面所处场景");
    expect(ROLE_DESIGNS.visual.systemPrompt).toContain("核心对象、关键属性、状态");
    expect(ROLE_DESIGNS.accessibility.systemPrompt).toContain("建立语义关联");
    expect(ROLE_DESIGNS.interaction.systemPrompt).toContain("查看、比较、选择还是管理");
    expect(ROLE_DESIGNS.visual.systemPrompt).toContain("不要预设某一种固定版式、内容字段或组件形态");
    expect(ROLE_DESIGNS.visual.systemPrompt).not.toContain("预约");
    expect(ROLE_DESIGNS.visual.systemPrompt).not.toContain("医生");
    expect(ROLE_DESIGNS.visual.systemPrompt).not.toContain("头像");
    expect(visual).not.toContain("Text is too small");
    expect(interaction).not.toContain("Text is too small");
    expect(accessibility).toContain("Text is too small");
    if (typeof visualInput !== "string") throw new Error("Expected text-only visual input in this fixture.");
    expect(visualInput).toContain('"absoluteY":200');
    expect(visualInput).toContain('"verticalGap":180');
    expect(visual).toContain("低于 85 分");
    expect(visual).toContain("primaryNodeId");
    expect(visual).toContain('\\"aspect\\"');
    expect(visual).toContain('\\"direction\\"');
    expect(visual).toContain("from 节点");
    expect(visual).toContain("relatedNodeIds 非空时也必须提供 primaryNodeId");
    expect(visual).toContain("APPLE-DESIGN-TIPS");
    expect(visual).not.toContain("WCAG22-1.4.3");
    expect(accessibility).toContain("WCAG22-1.4.3");
    expect(interaction).toContain("NNG-VISIBILITY-OF-STATUS");
  });

  it("parses dimensions, resolves node names, and removes invented node IDs", async () => {
    const temperatures: Array<number | undefined> = [];
    const fakeClient = {
      async complete(request: CompletionRequest): Promise<CompletionResult> {
        temperatures.push(request.temperature);
        const prompt = JSON.stringify(request.messages);
        const dimensions = prompt.includes("信息层级")
          ? ["信息层级", "布局留白", "一致性", "视觉节奏"]
          : prompt.includes("感知性")
            ? ["感知性", "可理解性", "可操作性", "包容性"]
            : ["操作路径", "反馈明确性", "状态可见性", "误操作防护"];
        const basisId = dimensions[0] === "信息层级"
          ? "APPLE-DESIGN-TIPS"
          : dimensions[0] === "感知性"
            ? "WCAG22-1.4.3"
            : "NNG-VISIBILITY-OF-STATUS";
        return {
          id: "test",
          model: "test-model",
          content: JSON.stringify({
            score: 80,
            dimensions: dimensions.map((label, index) => ({
              label,
              score: index === 0 ? 80 : 90,
              observation: `${label}的观察`,
            })),
            summary: "独立角色评审结果",
            issues: [
              { primaryNodeId: "text-1", relatedNodeIds: ["nav-1", "invented-1", "invented-2", "invented-3", "text-1"], severity: "medium", criterion: dimensions[0], title: "有效问题", evidence: "节点数据表明文本字号为12px。", basisIds: [basisId], explanation: "有效理由", suggestion: "有效建议" },
              { primaryNodeId: "nav-1", relatedNodeIds: [], severity: "high", criterion: dimensions[0], title: "高优先问题", evidence: "底部导航高度为40px。", basisIds: [basisId], explanation: "高优先理由", suggestion: "高优先建议" },
              { primaryNodeId: null, relatedNodeIds: ["text-1", "nav-1"], severity: "low", criterion: dimensions[1], title: "组件状态问题", evidence: "静态界面中没有状态文字。", basisIds: [], explanation: "主要节点遗漏", suggestion: "定位到具体组件" },
              { primaryNodeId: "invented-id", relatedNodeIds: [], severity: "low", criterion: dimensions[1], title: "虚构节点", evidence: "无效节点。", basisIds: [basisId], explanation: "无效", suggestion: "忽略" },
            ],
          }),
          latencyMs: 10,
          mock: false,
          usage: { promptTokens: null, completionTokens: null, totalTokens: null },
        };
      },
    } as BailianClient;
    const liveConfig = { ...config, mockMode: false, apiKey: "test-key" };
    const response = await new ReviewService(liveConfig, fakeClient).review(reviewRequest);

    expect(response.reviews.every((review) => review.dimensions.length === 4)).toBe(true);
    expect(response.reviews.every((review) => review.issues.length === 3)).toBe(true);
    expect(response.reviews[0].issues[0]).toMatchObject({ severity: "high", nodeId: "nav-1", nodeName: "Bottom navigation" });
    expect(response.reviews[0].issues[1]).toMatchObject({
      severity: "medium",
      nodeId: "text-1",
      nodeName: "Small copy",
      relatedNodes: [{ nodeId: "nav-1", nodeName: "Bottom navigation" }],
    });
    expect(response.reviews[0].issues[2]).toMatchObject({
      severity: "low",
      nodeId: "text-1",
      nodeName: "Small copy",
      basisIds: [],
      relatedNodes: [{ nodeId: "nav-1", nodeName: "Bottom navigation" }],
    });
    expect(temperatures).toEqual([0.2, 0.2, 0.2]);
  });

  it("retries once when a model returns malformed structured output", async () => {
    let calls = 0;
    const fakeClient = {
      async complete(): Promise<CompletionResult> {
        calls += 1;
        return {
          id: `test-${calls}`,
          model: "test-model",
          content: calls === 1
            ? "{\"score\":80,\"dimensions\":[]}"
            : JSON.stringify({
                score: 90,
                dimensions: ["A", "B", "C", "D"].map((label) => ({ label, score: 90, observation: "正常" })),
                summary: "结构完整",
                issues: [],
              }),
          latencyMs: 10,
          mock: false,
          usage: { promptTokens: null, completionTokens: null, totalTokens: null },
        };
      },
    } as BailianClient;
    const liveConfig = { ...config, mockMode: false, apiKey: "test-key" };

    const response = await new ReviewService(liveConfig, fakeClient).review(reviewRequest);

    expect(calls).toBe(4);
    expect(response.incomplete).toBe(false);
    expect(response.reviews.every((review) => review.status === "completed")).toBe(true);
  });

  it("rejects invented or role-inappropriate review bases", async () => {
    const fakeClient = {
      async complete(): Promise<CompletionResult> {
        return {
          id: "invalid-basis",
          model: "test-model",
          content: JSON.stringify({
            score: 80,
            dimensions: ["信息层级", "布局留白", "一致性", "视觉节奏"].map((label) => ({ label, score: 80, observation: "观察" })),
            summary: "带有无效依据的结果",
            issues: [{
              primaryNodeId: "text-1",
              relatedNodeIds: [],
              severity: "medium",
              criterion: "信息层级",
              title: "无效依据",
              evidence: "节点数据表明字号为12px。",
              basisIds: ["WCAG22-1.4.3"],
              explanation: "视觉角色不应引用仅供无障碍角色使用的标准。",
              suggestion: "重新选择可用依据。",
            }],
          }),
          latencyMs: 10,
          mock: false,
          usage: { promptTokens: null, completionTokens: null, totalTokens: null },
        };
      },
    } as BailianClient;
    const liveConfig = { ...config, mockMode: false, apiKey: "test-key" };
    const response = await new ReviewService(liveConfig, fakeClient).review(reviewRequest);

    expect(response.incomplete).toBe(true);
    expect(response.reviews.find((review) => review.role === "visual")?.status).toBe("failed");
    expect(response.reviews.find((review) => review.role === "accessibility")?.status).toBe("completed");
  });
});
