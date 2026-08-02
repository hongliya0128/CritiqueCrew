import type { RuleCheckResult, ScanResult } from "./messages";
import type {
  AgentReview,
  ReviewConflict,
  ReviewDifference,
  ReviewIssueReference,
  ReviewResponse,
} from "./review";

export type ReportFormat = "json" | "markdown";

export type EvaluationReport = {
  schemaVersion: "1.1";
  generatedAt: string;
  plugin: "CritiqueCrew";
  scope: {
    scope: ScanResult["scope"];
    rootId: string;
    rootName: string;
    rootType: string;
    pageId: string | null;
    pageName: string | null;
    nodeCount: number;
    truncated: boolean;
    scannedAt: string;
  };
  overview: {
    compositeScore: number | null;
    incomplete: boolean;
    ruleIssueCount: number;
    expertIssueCount: number;
    consensusCount: number;
    differenceCount: number;
    conflictCount: number;
    coordinationStatus: ReviewResponse["coordination"]["status"];
  };
  automatedRules: RuleCheckResult;
  expertReviews: AgentReview[];
  synthesis: {
    compositeScore: ReviewResponse["compositeScore"];
    coordination: ReviewResponse["coordination"];
  };
  execution: {
    mock: boolean;
    elapsedMs: number;
  };
};

const roleLabels = {
  visual: "视觉设计师",
  accessibility: "无障碍专家",
  interaction: "交互设计师",
} as const;

const severityLabels = {
  high: "高",
  medium: "中",
  low: "低",
} as const;

export function buildEvaluationReport(
  scan: ScanResult,
  rules: RuleCheckResult,
  review: ReviewResponse,
  generatedAt = new Date().toISOString(),
): EvaluationReport {
  return {
    schemaVersion: "1.1",
    generatedAt,
    plugin: "CritiqueCrew",
    scope: {
      scope: scan.scope,
      rootId: scan.rootId,
      rootName: scan.rootName,
      rootType: scan.rootType,
      pageId: scan.pageId ?? null,
      pageName: scan.pageName ?? null,
      nodeCount: scan.nodeCount,
      truncated: scan.truncated,
      scannedAt: scan.scannedAt,
    },
    overview: {
      compositeScore: review.compositeScore.score,
      incomplete: review.incomplete,
      ruleIssueCount: rules.issues.length,
      expertIssueCount: review.reviews.reduce((total, item) => total + item.issues.length, 0),
      consensusCount: review.coordination.consensus.length,
      differenceCount: review.coordination.differences.length,
      conflictCount: review.coordination.conflicts.length,
      coordinationStatus: review.coordination.status,
    },
    automatedRules: rules,
    expertReviews: review.reviews,
    synthesis: {
      compositeScore: review.compositeScore,
      coordination: review.coordination,
    },
    execution: {
      mock: review.mock,
      elapsedMs: review.elapsedMs,
    },
  };
}

function line(value: unknown): string {
  return String(value ?? "—").replace(/\r?\n/g, " ").trim() || "—";
}

function issueReferenceMarkdown(issue: ReviewIssueReference): string[] {
  return [
    `- **${roleLabels[issue.role]}**（${severityLabels[issue.severity]}优先级，${issue.direction}）：${line(issue.title)}`,
    `  - 证据：${line(issue.evidence)}`,
    `  - 说明：${line(issue.explanation)}`,
    `  - 建议：${line(issue.suggestion)}`,
  ];
}

function relationshipMarkdown(
  title: string,
  items: readonly (ReviewDifference | ReviewConflict)[],
): string[] {
  const result = [`### ${title}`];
  if (items.length === 0) return [...result, "", "无。", ""];
  for (const item of items) {
    result.push("", `#### ${line(item.nodeName)} · ${item.aspect}`, "", `- 节点 ID：\`${item.nodeId}\``, `- 判定原因：${line(item.reason)}`);
    result.push(...item.issues.flatMap(issueReferenceMarkdown));
  }
  result.push("");
  return result;
}

export function serializeReport(report: EvaluationReport, format: ReportFormat): string {
  if (format === "json") return `${JSON.stringify(report, null, 2)}\n`;

  const lines: string[] = [
    "# CritiqueCrew 多视角 UI 评估报告",
    "",
    `- 生成时间：${report.generatedAt}`,
    `- 评估范围：${line(report.scope.rootName)}（${report.scope.rootType}）`,
    `- 根节点 ID：\`${report.scope.rootId}\``,
    `- 可见节点：${report.scope.nodeCount}${report.scope.truncated ? "（扫描结果已截断）" : ""}`,
    `- 运行模式：${report.execution.mock ? "Mock" : "真实模型"}`,
    `- 结果完整性：${report.overview.incomplete ? "不完整，请查看失败项" : "完整"}`,
    "",
    "## 评估总览",
    "",
    `- 专家综合分：${report.overview.compositeScore ?? "—"}`,
    `- 自动化规则问题：${report.overview.ruleIssueCount} 项`,
    `- 专家评审问题：${report.overview.expertIssueCount} 项`,
    `- 关系分析：${report.overview.consensusCount} 项共识、${report.overview.differenceCount} 项判断差异、${report.overview.conflictCount} 项方向分歧`,
    "",
    "## 自动化规则检测",
    "",
  ];

  if (report.automatedRules.issues.length === 0) {
    lines.push("未发现规则违规项。", "");
  } else {
    for (const issue of report.automatedRules.issues) {
      lines.push(
        `### ${line(issue.message)}`,
        "",
        `- 规则：${issue.ruleId}`,
        `- 严重度：${issue.severity}`,
        `- 节点：${line(issue.nodeName)}（\`${issue.nodeId}\`）`,
        `- 检测值：${line(issue.actual)}`,
        `- 要求：${line(issue.expected)}`,
        "",
      );
    }
  }
  if (report.automatedRules.skippedContrastNodes > 0) {
    lines.push(`> ${report.automatedRules.skippedContrastNodes} 个文本节点因背景无法确定而跳过对比度计算。`, "");
  }

  lines.push("## 三位专家独立评审", "");
  for (const review of report.expertReviews) {
    lines.push(
      `### ${roleLabels[review.role]} · ${review.status === "completed" ? `${review.score} 分` : "评审失败"}`,
      "",
      `- 关注重点：${line(review.focus)}`,
      `- 结论：${line(review.summary)}`,
    );
    if (review.error) lines.push(`- 错误：${line(review.error)}`);
    if (review.dimensions.length > 0) {
      lines.push("", "#### 维度评分", "");
      for (const dimension of review.dimensions) {
        lines.push(`- **${line(dimension.label)}：${dimension.score} 分** — ${line(dimension.observation)}`);
      }
    }
    lines.push("", "#### 具体问题", "");
    if (review.issues.length === 0) lines.push("该视角未发现需要优先处理的问题。", "");
    for (const issue of review.issues) {
      const node = issue.nodeId ? `${line(issue.nodeName)}（\`${issue.nodeId}\`）` : `${line(issue.nodeName)}（屏幕级问题）`;
      lines.push(
        `##### ${line(issue.title)}`,
        "",
        `- 优先级：${severityLabels[issue.severity]}`,
        `- 主要节点：${node}`,
        `- 设计议题：${issue.aspect} / ${issue.direction}`,
        `- 问题描述：${line(issue.explanation)}`,
        `- 证据：${line(issue.evidence)}`,
        `- 修改建议：${line(issue.suggestion)}`,
      );
      if (issue.relatedNodes.length > 0) {
        lines.push(`- 关联节点：${issue.relatedNodes.map((item) => `${line(item.nodeName)}（\`${item.nodeId}\`）`).join("、")}`);
      }
      lines.push("");
    }
  }

  lines.push(
    "## 评审协调者：总体评价",
    "",
  );
  for (const perspective of report.synthesis.coordination.perspectives) {
    lines.push(`- **${roleLabels[perspective.role]}**：${line(perspective.summary)}`);
  }
  lines.push("", `> ${line(report.synthesis.coordination.overallSummary)}`, "");
  lines.push("### 共识");
  if (report.synthesis.coordination.consensus.length === 0) lines.push("", "无。", "");
  for (const consensus of report.synthesis.coordination.consensus) {
    lines.push("", `#### ${line(consensus.nodeName)} · ${consensus.aspect}`, "", `- 节点 ID：\`${consensus.nodeId}\``, `- 共同方向：${consensus.direction}`);
    lines.push(...consensus.issues.flatMap(issueReferenceMarkdown));
  }
  lines.push("", ...relationshipMarkdown("判断差异", report.synthesis.coordination.differences));

  lines.push("### 方向分歧", "");
  if (report.synthesis.coordination.conflicts.length === 0) lines.push("无。", "");
  for (const conflict of report.synthesis.coordination.conflicts) {
    const tradeoff = report.synthesis.coordination.tradeoffs.find((item) => item.conflictId === conflict.id);
    lines.push(
      `#### ${line(tradeoff?.topic ?? `${conflict.nodeName} · ${conflict.aspect}`)}`,
      "",
      `- 节点：${line(conflict.nodeName)}（\`${conflict.nodeId}\`）`,
      `- 分歧原因：${line(conflict.reason)}`,
    );
    lines.push(...conflict.issues.flatMap(issueReferenceMarkdown));
    lines.push(
      `- 核心权衡：${line(tradeoff?.tradeoffSummary)}`,
      `- 协调建议：${line(tradeoff?.coordinatedSuggestion)}`,
      ...(tradeoff?.unresolvedNote ? [`- 保留分歧：${line(tradeoff.unresolvedNote)}`] : []),
      "",
    );
  }

  lines.push("---", "", "由 CritiqueCrew 导出。自动化规则结果与 AI 专业评审结论应结合实际设计场景复核。", "");
  return lines.join("\n");
}

export function createReportFilename(rootName: string, format: ReportFormat, generatedAt: string): string {
  const safeRoot = Array.from(rootName, (character) =>
    character.charCodeAt(0) < 32 || '<>:"/\\|?*'.includes(character) ? "-" : character,
  ).join("")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48) || "ui-review";
  const timestamp = generatedAt.replace(/\.\d{3}Z$/, "Z").replace(/[:]/g, "-");
  return `CritiqueCrew-${safeRoot}-${timestamp}.${format === "json" ? "json" : "md"}`;
}
