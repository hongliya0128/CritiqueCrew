import { describe, expect, it } from "vitest";
import { analyzeReviewRelationships, calculateCompositeScore } from "../src/shared/arbitration";
import { buildCoordinationMessages } from "../server/coordination-service";
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
    const reviews = [
      review("visual", [issue("visual-1", "medium", "weaken")]),
      review("interaction", [issue("interaction-1", "high", "strengthen")]),
    ];
    const result = analyzeReviewRelationships(reviews);

    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]).toMatchObject({
      nodeId: "button-1",
      aspect: "visual-prominence",
    });
    expect(result.consensus).toHaveLength(0);
    const messages = JSON.stringify(buildCoordinationMessages(reviews, result, calculateCompositeScore(reviews)));
    expect(messages).toContain("测试证据");
    expect(messages).toContain("测试说明");
    expect(messages).toContain("不得把 suggestion 当作事实");
    expect(messages).toContain("overallSummary");
    expect(messages).toContain("perspectives");
    expect(messages).toContain("tradeoffs");
    expect(messages).toContain("视觉设计师概括视觉层级和版式表现");
    expect(messages).toContain("无障碍专家概括内容理解和包容性风险");
    expect(messages).toContain("交互设计师概括任务路径、反馈和误操作风险");
    expect(messages).toContain("不再从视觉、无障碍、交互三个方面逐项复述");
    expect(messages).toContain("每条只写一句话，建议 25 至 50 个字符");
    expect(messages).toContain("保留该专家原本的判断重点和表达顺序");
    expect(messages).toContain("三条不得套用相同的转折结构");
    expect(messages).toContain("优先使用“整体……”或“综合来看，……”");
    expect(messages).toContain("输入中的英文术语必须先改写成通俗中文");
    expect(messages).toContain("不得向用户提出需要回复的问题");
    expect(messages).toContain("不是替用户裁决的仲裁者");
  });

  it("classifies matching directions with a two-level severity gap only as a judgment difference", () => {
    const result = analyzeReviewRelationships([
      review("visual", [issue("visual-1", "low", "strengthen")]),
      review("interaction", [issue("interaction-1", "high", "strengthen")]),
    ]);

    expect(result.conflicts).toHaveLength(0);
    expect(result.consensus).toHaveLength(0);
    expect(result.differences).toHaveLength(1);
  });

  it("classifies matching directions with a small severity gap only as consensus", () => {
    const result = analyzeReviewRelationships([
      review("visual", [issue("visual-1", "medium", "strengthen")]),
      review("interaction", [issue("interaction-1", "high", "strengthen")]),
    ]);

    expect(result.conflicts).toHaveLength(0);
    expect(result.consensus).toHaveLength(1);
    expect(result.differences).toHaveLength(0);
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
