import { describe, expect, it } from "vitest";
import {
  buildEvaluationReport,
  createReportFilename,
  serializeReport,
} from "../src/shared/report-export";
import type { RuleCheckResult, ScanResult } from "../src/shared/messages";
import type { ReviewResponse } from "../src/shared/review";

const scan: ScanResult = {
  scope: "selection",
  rootId: "62:94",
  rootName: "Screen/A05/预约列表",
  rootType: "FRAME",
  pageId: "0:1",
  pageName: "医疗 App",
  nodeCount: 31,
  nodes: [],
  truncated: false,
  screenshotBase64: "very-large-image-data",
  scannedAt: "2026-08-01T08:00:00.000Z",
};

const rules: RuleCheckResult = {
  skippedContrastNodes: 1,
  issues: [
    {
      id: "rule-1",
      ruleId: "target-size",
      severity: "error",
      nodeId: "button-1",
      nodeName: "预约按钮",
      nodeType: "FRAME",
      message: "点击区域过小",
      actual: "36 × 36 px",
      expected: "至少 44 × 44 px",
    },
  ],
};

const review: ReviewResponse = {
  reviews: [
    {
      role: "visual",
      focus: "层级与视觉节奏",
      score: 78,
      dimensions: [{ label: "信息层级", score: 76, observation: "主要操作不够突出" }],
      summary: "整体可用，但主要操作需要强化。",
      issues: [
        {
          id: "visual-1",
          nodeId: "button-1",
          nodeName: "预约按钮",
          relatedNodes: [{ nodeId: "card-1", nodeName: "预约卡片" }],
          severity: "high",
          criterion: "操作入口",
          aspect: "visual-prominence",
          direction: "strengthen",
          title: "主要操作入口不够突出",
          evidence: "按钮与次要元素视觉重量接近。",
          basisIds: [],
          explanation: "用户可能无法快速识别下一步操作。",
          suggestion: "提高按钮对比度并增加留白。",
        },
      ],
      status: "completed",
      latencyMs: 1200,
      error: null,
    },
  ],
  coordination: {
    status: "completed",
    consensus: [],
    differences: [],
    conflicts: [
      {
        id: "conflict-1",
        nodeId: "button-1",
        nodeName: "预约按钮",
        aspect: "visual-prominence",
        reason: "两位专家提出互斥方向。",
        issues: [
          {
            role: "visual",
            issueId: "visual-1",
            severity: "high",
            direction: "strengthen",
            title: "主要操作入口不够突出",
            evidence: "按钮与次要元素视觉重量接近。",
            explanation: "用户可能无法快速识别下一步操作。",
            suggestion: "提高按钮对比度并增加留白。",
          },
        ],
      },
    ],
    perspectives: [
      { role: "visual", summary: "视觉层级基本清楚，但主要操作仍需加强。" },
    ],
    tradeoffs: [
      {
        conflictId: "conflict-1",
        topic: "主要操作的视觉强调程度",
        tradeoffSummary: "需要兼顾操作可发现性与页面视觉平衡。",
        coordinatedSuggestion: "保留清晰入口，同时控制强调程度，避免压过页面主体。",
        unresolvedNote: "",
      },
    ],
    overallSummary: "整体完成度中等，页面结构可以识别，但主要操作的可发现性和细节一致性仍有提升空间。",
    latencyMs: 800,
    error: null,
  },
  compositeScore: {
    score: 78,
    incomplete: false,
    components: [{ source: "visual", score: 78, configuredWeight: 1 / 3, appliedWeight: 1 }],
  },
  incomplete: false,
  elapsedMs: 2000,
  mock: false,
};

describe("report export", () => {
  it("builds a compact structured report without the screenshot or full node tree", () => {
    const report = buildEvaluationReport(scan, rules, review, "2026-08-01T09:30:00.000Z");
    const json = serializeReport(report, "json");

    expect(report.overview).toMatchObject({
      compositeScore: 78,
      ruleIssueCount: 1,
      expertIssueCount: 1,
      conflictCount: 1,
    });
    expect(json).toContain('"nodeId": "button-1"');
    expect(json).toContain('"label": "信息层级"');
    expect(json).toContain('"score": 76');
    expect(json).toContain('"summary": "整体可用，但主要操作需要强化。"');
    expect(json).toContain('"explanation": "用户可能无法快速识别下一步操作。"');
    expect(json).toContain('"suggestion": "提高按钮对比度并增加留白。"');
    expect(json).toContain('"overallSummary": "整体完成度中等，页面结构可以识别，但主要操作的可发现性和细节一致性仍有提升空间。"');
    expect(json).not.toContain("very-large-image-data");
    expect(json).not.toContain('"nodes"');
  });

  it("renders a readable Markdown report with scores, node locations, and coordinated suggestions", () => {
    const report = buildEvaluationReport(scan, rules, review, "2026-08-01T09:30:00.000Z");
    const markdown = serializeReport(report, "markdown");

    expect(markdown).toContain("# CritiqueCrew 多视角 UI 评估报告");
    expect(markdown).toContain("专家综合分：78");
    expect(markdown).toContain("信息层级：76 分");
    expect(markdown).toContain("结论：整体可用，但主要操作需要强化。");
    expect(markdown).toContain("预约按钮（`button-1`）");
    expect(markdown).toContain("修改建议：提高按钮对比度并增加留白。");
    expect(markdown).toContain("总体评价");
    expect(markdown).toContain("评审协调者：总体评价");
    expect(markdown).toContain("视觉设计师**：视觉层级基本清楚，但主要操作仍需加强。");
    expect(markdown).toContain("协调建议：保留清晰入口，同时控制强调程度，避免压过页面主体。");
  });

  it("creates Windows-safe filenames for both formats", () => {
    expect(createReportFilename(scan.rootName, "markdown", "2026-08-01T09:30:00.000Z"))
      .toBe("CritiqueCrew-Screen-A05-预约列表-2026-08-01T09-30-00Z.md");
    expect(createReportFilename("A05:预约*列表?", "json", "2026-08-01T09:30:00.000Z"))
      .toBe("CritiqueCrew-A05-预约-列表-2026-08-01T09-30-00Z.json");
  });
});
