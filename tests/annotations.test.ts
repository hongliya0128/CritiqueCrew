import { describe, expect, it } from "vitest";
import {
  aggregateReviewAnnotations,
  chooseReverseLocateTarget,
  findHighestPriorityReviewIssue,
} from "../src/shared/annotations";
import type { AgentReview } from "../src/shared/review";

describe("aggregateReviewAnnotations", () => {
  it("merges duplicate nodes, preserves roles, and keeps the highest severity", () => {
    const result = aggregateReviewAnnotations([
      {
        nodeId: "node-1",
        nodeName: "Primary action",
        role: "visual",
        severity: "medium",
        screenLevel: false,
      },
      {
        nodeId: "node-1",
        nodeName: "Primary action",
        role: "accessibility",
        severity: "high",
        screenLevel: false,
      },
      {
        nodeId: "node-1",
        nodeName: "Primary action",
        role: "visual",
        severity: "low",
        screenLevel: true,
      },
    ]);

    expect(result).toEqual([
      {
        nodeId: "node-1",
        nodeName: "Primary action",
        roles: ["visual", "accessibility"],
        severity: "high",
        screenLevel: true,
      },
    ]);
  });

  it("keeps different target nodes as separate annotations", () => {
    const result = aggregateReviewAnnotations([
      {
        nodeId: "node-1",
        nodeName: "First",
        role: "interaction",
        severity: "low",
        screenLevel: false,
      },
      {
        nodeId: "node-2",
        nodeName: "Second",
        role: "interaction",
        severity: "medium",
        screenLevel: false,
      },
    ]);

    expect(result.map((target) => target.nodeId)).toEqual(["node-1", "node-2"]);
  });

  it("finds the highest-priority review issue for a selected node", () => {
    const review = (
      role: AgentReview["role"],
      severity: AgentReview["issues"][number]["severity"],
      id: string,
    ): AgentReview => ({
      role,
      focus: "",
      score: 80,
      dimensions: [],
      summary: "",
      issues: [{
        id,
        nodeId: "node-1",
        nodeName: "Target",
        relatedNodes: [],
        severity,
        criterion: "",
        title: id,
        explanation: "",
        suggestion: "",
      }],
      status: "completed",
      latencyMs: 0,
      error: null,
    });

    const result = findHighestPriorityReviewIssue([
      review("visual", "medium", "visual-medium"),
      review("accessibility", "high", "accessibility-high"),
      review("interaction", "low", "interaction-low"),
    ], "node-1");

    expect(result).toMatchObject({
      role: "accessibility",
      issue: { id: "accessibility-high", severity: "high" },
    });
    expect(findHighestPriorityReviewIssue([], "node-1")).toBeNull();
  });

  it("routes reverse location only through active annotations and prefers the highest review issue", () => {
    const makeReview = (
      role: AgentReview["role"],
      severity: AgentReview["issues"][number]["severity"],
      id: string,
    ): AgentReview => ({
      role,
      focus: "",
      score: 80,
      dimensions: [],
      summary: "",
      issues: [{
        id,
        nodeId: "node-1",
        nodeName: "Target",
        relatedNodes: [],
        severity,
        criterion: "信息层级",
        aspect: "visual-prominence",
        direction: "strengthen",
        title: id,
        evidence: "测试证据",
        basisIds: [],
        explanation: "测试说明",
        suggestion: "测试建议",
      }],
      status: "completed",
      latencyMs: 0,
      error: null,
    });
    const reviews = [
      makeReview("visual", "medium", "visual-medium"),
      makeReview("interaction", "high", "interaction-high"),
    ];
    const ruleIssues = [{
      id: "font-size:node-1",
      ruleId: "font-size" as const,
      severity: "error" as const,
      nodeId: "node-1",
      nodeName: "Target",
      nodeType: "TEXT",
      message: "字号偏小",
      actual: "12px",
      expected: "14px",
    }];
    const none = new Set<string>();
    const nodeOne = new Set(["node-1"]);

    expect(chooseReverseLocateTarget({
      nodeId: "node-1",
      ruleAnnotationNodeIds: none,
      reviewAnnotationNodeIds: none,
      ruleIssues,
      reviews,
    })).toBeNull();

    expect(chooseReverseLocateTarget({
      nodeId: "node-1",
      ruleAnnotationNodeIds: nodeOne,
      reviewAnnotationNodeIds: none,
      ruleIssues,
      reviews,
    })).toMatchObject({ kind: "rule", issue: { id: "font-size:node-1" } });

    expect(chooseReverseLocateTarget({
      nodeId: "node-1",
      ruleAnnotationNodeIds: none,
      reviewAnnotationNodeIds: nodeOne,
      ruleIssues,
      reviews,
    })).toMatchObject({
      kind: "review",
      match: { role: "interaction", issue: { id: "interaction-high", severity: "high" } },
    });

    expect(chooseReverseLocateTarget({
      nodeId: "node-1",
      ruleAnnotationNodeIds: nodeOne,
      reviewAnnotationNodeIds: nodeOne,
      ruleIssues,
      reviews,
    })).toMatchObject({
      kind: "review",
      match: { role: "interaction", issue: { id: "interaction-high", severity: "high" } },
    });
  });
});
