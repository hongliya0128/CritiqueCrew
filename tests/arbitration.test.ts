import { describe, expect, it } from "vitest";
import { analyzeReviewRelationships, calculateCompositeScore } from "../src/shared/arbitration";
import { buildArbitrationMessages } from "../server/arbitration-service";
import type {
  AgentReview,
  ReviewDirection,
  ReviewIssue,
  ReviewerRole,
  ReviewSeverity,
} from "../src/shared/review";

function issue(
  id: string,
  severity: ReviewSeverity,
  direction: ReviewDirection,
  nodeId = "button-1",
): ReviewIssue {
  return {
    id,
    nodeId,
    nodeName: "主要按钮",
    relatedNodes: [],
    severity,
    criterion: "信息层级",
    aspect: "visual-prominence",
    direction,
    title: `${direction} 按钮`,
    evidence: "测试证据",
    basisIds: [],
    explanation: "测试说明",
    suggestion: `${direction} 按钮视觉重量`,
  };
}

function review(role: ReviewerRole, issues: ReviewIssue[], score = 80): AgentReview {
  return {
    role,
    focus: "测试关注点",
    score,
    dimensions: [],
    summary: "测试评审",
    issues,
    status: "completed",
    latencyMs: 1,
    error: null,
  };
}

describe("analyzeReviewRelationships", () => {
  it("treats mutually exclusive directions on the same node and aspect as a conflict", () => {
    const result = analyzeReviewRelationships([
      review("visual", [issue("visual-1", "medium", "weaken")]),
      review("interaction", [issue("interaction-1", "high", "strengthen")]),
    ]);

    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]).toMatchObject({
      nodeId: "button-1",
      aspect: "visual-prominence",
    });
    expect(result.consensus).toHaveLength(0);
    const messages = JSON.stringify(buildArbitrationMessages(result.conflicts));
    expect(messages).toContain("测试证据");
    expect(messages).toContain("测试说明");
    expect(messages).toContain("不得把 suggestion 当作事实证据");
    expect(messages).toContain("resolution 和 rationale 必须分别控制在 240 个字符以内");
    expect(messages).toContain("最终建议或折中方案，不超过240个字符");
    expect(messages).toContain("为什么这样判断，不超过240个字符");
  });

  it("keeps matching recommendations as consensus and records a two-level severity difference", () => {
    const result = analyzeReviewRelationships([
      review("visual", [issue("visual-1", "low", "strengthen")]),
      review("interaction", [issue("interaction-1", "high", "strengthen")]),
    ]);

    expect(result.conflicts).toHaveLength(0);
    expect(result.consensus).toHaveLength(1);
    expect(result.differences).toHaveLength(1);
  });

  it("does not infer disagreement from another role staying silent", () => {
    const result = analyzeReviewRelationships([
      review("visual", [issue("visual-1", "high", "weaken")]),
      review("interaction", []),
    ]);

    expect(result).toEqual({ consensus: [], differences: [], conflicts: [] });
  });
});

describe("calculateCompositeScore", () => {
  it("averages successful expert scores and renormalizes when one role fails", () => {
    const failed = { ...review("interaction", [], 0), status: "failed" as const };
    const result = calculateCompositeScore([
      review("visual", [], 80),
      review("accessibility", [], 90),
      failed,
    ]);

    expect(result.score).toBe(85);
    expect(result.incomplete).toBe(true);
    expect(result.components.map((component) => component.source)).toEqual(["visual", "accessibility"]);
  });
});
