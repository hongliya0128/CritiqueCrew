import { describe, expect, it } from "vitest";
import {
  buildReviewMessages,
  normalizeReviewDirection,
  ROLE_DESIGNS,
  ReviewService,
} from "../server/review-service";
import type { BailianClient, CompletionRequest, CompletionResult } from "../server/bailian-client";
import type { ServerConfig } from "../server/config";
import type { ReviewRequest } from "../src/shared/review";

const config: ServerConfig = {
  provider: "bailian", apiKey: "", baseUrl: "https://example.test/v1", model: "test-model", port: 8787, mockMode: true,
};

const reviewRequest: ReviewRequest = {
  scan: {
    scope: "selection", rootId: "frame-1", rootName: "Test frame", rootType: "FRAME", nodeCount: 3, truncated: false,
    nodes: [
      { id: "frame-1", parentId: null, childIds: ["text-1", "nav-1"], name: "Test frame", type: "FRAME", depth: 0, visible: true, locked: false, x: 0, y: 0, absoluteX: 0, absoluteY: 0, width: 320, height: 300, rotation: 0, opacity: 1, fills: [], fillKind: "none", hasPointerInteraction: false, fontSize: null, characters: null, cornerRadius: 16 },
      { id: "text-1", parentId: "frame-1", childIds: [], name: "Small copy", type: "TEXT", depth: 1, visible: true, locked: false, x: 0, y: 0, absoluteX: 0, absoluteY: 0, width: 120, height: 20, rotation: 0, opacity: 1, fills: [], fillKind: "none", hasPointerInteraction: false, fontSize: 12, characters: "Hello", cornerRadius: null },
      { id: "nav-1", parentId: "frame-1", childIds: [], name: "Bottom navigation", type: "FRAME", depth: 1, visible: true, locked: false, x: 0, y: 200, absoluteX: 0, absoluteY: 200, width: 320, height: 40, rotation: 0, opacity: 0.9, fills: [{ r: 0.1, g: 0.4, b: 0.9, a: 1 }], fillKind: "solid", hasPointerInteraction: true, fontSize: null, characters: null, cornerRadius: 12 },
    ],
  },
  rules: { issues: [{ id: "font-size:text-1", ruleId: "font-size", severity: "error", nodeId: "text-1", nodeName: "Small copy", nodeType: "TEXT", message: "Text is too small", actual: "12px", expected: "14px" }], skippedContrastNodes: 0 },
};

describe("ReviewService", () => {
  it("keeps modification direction consistent with the visible conclusion", () => {
    expect(normalizeReviewDirection({
      direction: "strengthen",
      title: "取消预约按钮视觉权重过高干扰主要任务",
      suggestion: "弱化取消预约按钮样式，让主操作更容易识别。",
    })).toBe("weaken");
    expect(normalizeReviewDirection({
      direction: "weaken",
      title: "取消预约按钮视觉权重过高",
      suggestion: "降低该按钮的视觉权重。",
    })).toBe("weaken");
    expect(normalizeReviewDirection({
      direction: "weaken",
      title: "主操作按钮不明显，容易被忽略",
      suggestion: "强化主操作按钮，让它更醒目。",
    })).toBe("strengthen");
    expect(normalizeReviewDirection({
      direction: "unspecified",
      title: "按钮关系需要进一步确认",
      suggestion: "结合真实交互继续验证。",
    })).toBe("unspecified");
  });

  it("returns three independent role reviews in Mock mode", async () => {
    const response = await new ReviewService(config).review(reviewRequest);

    expect(response.mock).toBe(true);
    expect(response.incomplete).toBe(false);
    expect(response.reviews.map((review) => review.role)).toEqual(["visual", "accessibility", "interaction"]);
    expect(response.reviews.every((review) => review.status === "completed")).toBe(true);
    expect(response.reviews.find((review) => review.role === "accessibility")?.issues[0]?.nodeId).toBe("text-1");
    expect(response.coordination.status).toBe("completed");
    expect(response.coordination.conflicts).toHaveLength(1);
    expect(response.coordination.tradeoffs).toHaveLength(1);
    expect(response.coordination.overallSummary).not.toBe("");
    expect(response.compositeScore.score).toBe(73);
  });

  it("starts the three expert requests concurrently before coordination", async () => {
    let activeRoleCalls = 0;
    let maximumActiveRoleCalls = 0;
    let releaseRoleCalls: (() => void) | undefined;
    const allRolesStarted = new Promise<void>((resolve) => {
      releaseRoleCalls = resolve;
    });
    const fakeClient = {
      async complete(request: CompletionRequest): Promise<CompletionResult> {
        const prompt = JSON.stringify(request.messages);
        if (prompt.includes("评审协调者")) {
          return {
            id: "coordination-after-concurrent-reviews",
            model: "test-model",
            content: JSON.stringify({
              perspectives: [
                { role: "visual", summary: "页面结构清楚，视觉层级能够支持主要内容识别。" },
                { role: "accessibility", summary: "内容关系可以理解，主要说明能够帮助用户获取信息。" },
                { role: "interaction", summary: "任务入口可以识别，基础操作路径较为连贯。" },
              ],
              overallSummary: "综合来看，页面已经具备清楚的基础结构和任务框架，后续可继续完善局部细节。",
              tradeoffs: [],
            }),
            latencyMs: 1,
            mock: false,
            usage: { promptTokens: null, completionTokens: null, totalTokens: null },
          };
        }

        activeRoleCalls += 1;
        maximumActiveRoleCalls = Math.max(maximumActiveRoleCalls, activeRoleCalls);
        if (activeRoleCalls === 3) releaseRoleCalls?.();
        await Promise.race([
          allRolesStarted,
          new Promise<void>((resolve) => setTimeout(resolve, 100)),
        ]);
        activeRoleCalls -= 1;

        const dimensions = prompt.includes("信息层级")
          ? ["信息层级", "布局留白", "一致性", "视觉节奏"]
          : prompt.includes("说明与纠错")
            ? ["可理解性", "信息关系", "说明与纠错", "可预期性", "包容性"]
            : ["操作路径合理性", "反馈明确性", "误操作风险"];
        return {
          id: `role-${dimensions[0]}`,
          model: "test-model",
          content: JSON.stringify({
            score: 80,
            dimensions: dimensions.map((label) => ({ label, score: 80, observation: "基础表现稳定。" })),
            summary: "该视角的基础表现稳定。",
            issues: [],
          }),
          latencyMs: 1,
          mock: false,
          usage: { promptTokens: null, completionTokens: null, totalTokens: null },
        };
      },
    } as BailianClient;

    const response = await new ReviewService(
      { ...config, mockMode: false, apiKey: "test-key" },
      fakeClient,
    ).review(reviewRequest);

    expect(maximumActiveRoleCalls).toBe(3);
    expect(response.reviews.every((review) => review.status === "completed")).toBe(true);
    expect(response.coordination.status).toBe("completed");
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
    expect(ROLE_DESIGNS.visual.systemPrompt).toContain("【角色设定】");
    expect(ROLE_DESIGNS.accessibility.systemPrompt).toContain("说明与纠错");
    expect(ROLE_DESIGNS.accessibility.systemPrompt).toContain("认知负担");
    expect(ROLE_DESIGNS.interaction.systemPrompt).not.toContain("评分维度固定为：操作路径、反馈明确性、状态可见性");
    expect(ROLE_DESIGNS.visual.systemPrompt).toContain("识别页面所处场景");
    expect(ROLE_DESIGNS.visual.systemPrompt).toContain("标题、关键数据、主要按钮");
    expect(ROLE_DESIGNS.accessibility.systemPrompt).toContain("相关信息是否放在一起");
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
    expect(visualInput).toContain('"largestSiblingGaps"');
    expect(visualInput).toContain('"containerEdgeWhitespace"');
    expect(visualInput).toContain('"bottomGap":60');
    expect(visualInput).toContain('"bottomGapRatio":0.2');
    expect(visualInput).toContain('"fills":[{"r":0.1,"g":0.4,"b":0.9,"a":1}]');
    expect(visualInput).toContain('"opacity":0.9');
    expect(visualInput).toContain('"evidencePolicy"');
    expect(visualInput).toContain("Use the screenshot as the primary evidence for rendered color");
    expect(visualInput).toContain("Use node dimensions, absolute positions, parent relationships, and depth as the authoritative evidence");
    expect(visualInput).toContain("do not state a definite issue");
    expect(visual).toContain("低于 85 分");
    expect(visual).toContain("必须先判断页面整体内容分布和容器边缘空白");
    expect(visual).toContain("某个相邻间距数值较大不等于存在问题");
    expect(visual).toContain("让没有设计专业背景的人直接看懂");
    expect(visual).toContain("只有文字或细边框、背景不明显的次要按钮");
    expect(visual).toContain("按钮与上方提示区域距离太近");
    expect(visual).toContain("除 px、pt、rem、ms、s 等计量单位外");
    expect(visual).toContain("将 padding 写成“内边距”");
    expect(visual).toContain("primaryNodeId");
    expect(visual).toContain('\\"aspect\\"');
    expect(visual).toContain('\\"direction\\"');
    expect(visual).toContain("from 节点");
    expect(visual).toContain("relatedNodeIds 非空时也必须提供 primaryNodeId");
    expect(visual).toContain("APPLE-DESIGN-TIPS");
    expect(visual).not.toContain("WCAG22-1.4.3");
    expect(accessibility).toContain("WCAG22-1.4.3");
    expect(accessibility).toContain("W3C-COGA-CLEAR-CONTENT");
    expect(accessibility).toContain("MICROSOFT-INCLUSIVE-DESIGN");
    expect(accessibility).toContain("必须逐一评价 5 个指定维度");
    expect(interaction).toContain("NNG-VISIBILITY-OF-STATUS");
    expect(interaction).toContain("APPLE-FEEDBACK");
    expect(interaction).toContain("必须逐一评价 3 个指定维度");
  });

  it("parses dimensions, resolves node names, and removes invented node IDs", async () => {
    const temperatures: Array<number | undefined> = [];
    const fakeClient = {
      async complete(request: CompletionRequest): Promise<CompletionResult> {
        temperatures.push(request.temperature);
        const prompt = JSON.stringify(request.messages);
        if (prompt.includes("评审协调者")) {
          return {
            id: "coordination",
            model: "test-model",
            content: JSON.stringify({
              perspectives: [
                { role: "visual", summary: "页面信息层级基本清楚，但主要内容与次要信息的视觉差异仍可加强。" },
                { role: "accessibility", summary: "内容关系大体能够理解，但部分说明和不同用户的使用风险仍需检查。" },
                { role: "interaction", summary: "任务入口可以识别，但操作反馈和任务衔接仍有完善空间。" },
              ],
              overallSummary: "整体完成度中等，页面已经具备基本结构，但信息辨识和任务衔接仍不够稳定，细节一致性也有继续完善的空间。建议优先处理同时影响理解与操作的高影响问题。",
              tradeoffs: [],
            }),
            latencyMs: 10,
            mock: false,
            usage: { promptTokens: null, completionTokens: null, totalTokens: null },
          };
        }
        const dimensions = prompt.includes("信息层级")
          ? ["信息层级", "布局留白", "一致性", "视觉节奏"]
          : prompt.includes("说明与纠错")
            ? ["可理解性", "信息关系", "说明与纠错", "可预期性", "包容性"]
            : ["操作路径合理性", "反馈明确性", "误操作风险"];
        const basisId = dimensions[0] === "信息层级"
          ? "APPLE-DESIGN-TIPS"
          : dimensions[0] === "可理解性"
            ? "W3C-COGA-CLEAR-CONTENT"
            : "APPLE-DESIGN-PRINCIPLES";
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
              { primaryNodeId: "text-1", relatedNodeIds: ["nav-1", "invented-1", "invented-2", "invented-3", "text-1"], severity: "medium", criterion: dimensions[0], title: "按钮缺乏足够的呼吸感", evidence: "节点数据表明文本字号为12px。", basisIds: [basisId], explanation: "有效理由", suggestion: "有效建议" },
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

    expect(response.reviews.map((review) => review.dimensions.length)).toEqual([4, 5, 3]);
    expect(response.reviews.every((review) => review.issues.length === 3)).toBe(true);
    expect(response.reviews[0].issues[0]).toMatchObject({ severity: "high", nodeId: "nav-1", nodeName: "Bottom navigation" });
    expect(response.reviews[0].issues[1]).toMatchObject({
      severity: "medium",
      nodeId: "text-1",
      nodeName: "Small copy",
      title: "按钮间距太小",
      relatedNodes: [{ nodeId: "nav-1", nodeName: "Bottom navigation" }],
    });
    expect(response.reviews[0].issues[2]).toMatchObject({
      severity: "low",
      nodeId: "text-1",
      nodeName: "Small copy",
      basisIds: [],
      relatedNodes: [{ nodeId: "nav-1", nodeName: "Bottom navigation" }],
    });
    expect(temperatures).toEqual([0.2, 0.2, 0.2, 0.1]);
  });

  it("retries once when a model returns malformed structured output", async () => {
    let calls = 0;
    const fakeClient = {
      async complete(request: CompletionRequest): Promise<CompletionResult> {
        calls += 1;
        const prompt = JSON.stringify(request.messages);
        if (prompt.includes("评审协调者")) {
          return {
            id: `test-${calls}`,
            model: "test-model",
            content: JSON.stringify({
              perspectives: [
                { role: "visual", summary: "页面结构基本清楚，视觉层级能够支持主要内容的识别。" },
                { role: "accessibility", summary: "内容关系可以理解，主要说明能够帮助用户获取信息。" },
                { role: "interaction", summary: "任务入口能够识别，基础操作路径基本连贯。" },
              ],
              overallSummary: "整体完成度较好，页面基础体验较为完整，各视角没有形成方向分歧，但局部细节的一致性、信息说明和反馈完整度仍有继续优化的空间。",
              tradeoffs: [],
            }),
            latencyMs: 10,
            mock: false,
            usage: { promptTokens: null, completionTokens: null, totalTokens: null },
          };
        }
        const dimensions = prompt.includes("信息层级")
          ? ["信息层级", "布局留白", "一致性", "视觉节奏"]
          : prompt.includes("说明与纠错")
            ? ["可理解性", "信息关系", "说明与纠错", "可预期性", "包容性"]
            : ["操作路径合理性", "反馈明确性", "误操作风险"];
        return {
          id: `test-${calls}`,
          model: "test-model",
          content: calls === 1
            ? "{\"score\":80,\"dimensions\":[]}"
            : JSON.stringify({
                score: 90,
                dimensions: dimensions.map((label) => ({ label, score: 90, observation: "正常" })),
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

    expect(calls).toBe(5);
    expect(response.incomplete).toBe(false);
    expect(response.reviews.every((review) => review.status === "completed")).toBe(true);
    expect(response.coordination.status).toBe("completed");
    expect(response.coordination.conflicts).toHaveLength(0);
    expect(response.coordination.tradeoffs).toHaveLength(0);
    expect(response.coordination.overallSummary).not.toBe("");
  });

  it("rejects invented or role-inappropriate review bases", async () => {
    const fakeClient = {
      async complete(request: CompletionRequest): Promise<CompletionResult> {
        const prompt = JSON.stringify(request.messages);
        if (prompt.includes("评审协调者")) {
          return {
            id: "coordination-after-partial-review",
            model: "test-model",
            content: JSON.stringify({
              perspectives: [
                { role: "accessibility", summary: "内容基本可以理解，但说明完整性和不同用户的使用风险仍需检查。" },
                { role: "interaction", summary: "任务能够完成，但操作反馈和步骤衔接仍有完善空间。" },
              ],
              overallSummary: "整体完成度暂时只能作有限判断，现有两个视角反映页面已经具备基本任务框架，但信息说明与操作衔接仍有完善空间；由于一个专家视角未成功返回，本次整体结论存在一定局限。",
              tradeoffs: [],
            }),
            latencyMs: 10,
            mock: false,
            usage: { promptTokens: null, completionTokens: null, totalTokens: null },
          };
        }
        const isVisual = prompt.includes("信息层级");
        const dimensions = isVisual
          ? ["信息层级", "布局留白", "一致性", "视觉节奏"]
          : prompt.includes("说明与纠错")
            ? ["可理解性", "信息关系", "说明与纠错", "可预期性", "包容性"]
            : ["操作路径合理性", "反馈明确性", "误操作风险"];
        return {
          id: "invalid-basis",
          model: "test-model",
          content: JSON.stringify({
            score: 80,
            dimensions: dimensions.map((label) => ({ label, score: 80, observation: "观察" })),
            summary: "带有无效依据的结果",
            issues: isVisual ? [{
              primaryNodeId: "text-1",
              relatedNodeIds: [],
              severity: "medium",
              criterion: "信息层级",
              title: "无效依据",
              evidence: "节点数据表明字号为12px。",
              basisIds: ["WCAG22-1.4.3"],
              explanation: "视觉角色不应引用仅供无障碍角色使用的标准。",
              suggestion: "重新选择可用依据。",
            }] : [],
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
