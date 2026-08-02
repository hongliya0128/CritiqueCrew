import type {
  AgentReview,
  CompositeScore,
  ReviewAspect,
  ReviewConflict,
  ReviewConsensus,
  ReviewDifference,
  ReviewIssue,
  ReviewIssueReference,
  ReviewerRole,
} from "./review";

const severityRank = { low: 1, medium: 2, high: 3 } as const;
const sourceWeights: Record<ReviewerRole, number> = {
  visual: 1 / 3,
  accessibility: 1 / 3,
  interaction: 1 / 3,
};

const oppositeDirections = new Set([
  "strengthen:weaken",
  "weaken:strengthen",
  "add:remove",
  "remove:add",
  "retain:remove",
  "remove:retain",
]);

type PositionedIssue = { role: ReviewerRole; issue: ReviewIssue };

function reference({ role, issue }: PositionedIssue): ReviewIssueReference {
  return {
    role,
    issueId: issue.id,
    severity: issue.severity,
    direction: issue.direction,
    title: issue.title,
    evidence: issue.evidence,
    explanation: issue.explanation,
    suggestion: issue.suggestion,
  };
}

function groupId(nodeId: string, aspect: ReviewAspect): string {
  return `${nodeId}:${aspect}`;
}

function hasOpposingDirections(group: readonly PositionedIssue[]): boolean {
  return group.some((left) =>
    group.some((right) =>
      left.role !== right.role
      && oppositeDirections.has(`${left.issue.direction}:${right.issue.direction}`),
    ),
  );
}

export function analyzeReviewRelationships(reviews: readonly AgentReview[]): {
  consensus: ReviewConsensus[];
  differences: ReviewDifference[];
  conflicts: ReviewConflict[];
} {
  const groups = new Map<string, PositionedIssue[]>();
  for (const review of reviews) {
    if (review.status !== "completed") continue;
    for (const issue of review.issues) {
      if (!issue.nodeId || issue.aspect === "other" || issue.direction === "unspecified") continue;
      const key = groupId(issue.nodeId, issue.aspect);
      const group = groups.get(key) ?? [];
      group.push({ role: review.role, issue });
      groups.set(key, group);
    }
  }

  const consensus: ReviewConsensus[] = [];
  const differences: ReviewDifference[] = [];
  const conflicts: ReviewConflict[] = [];

  for (const [id, group] of groups) {
    if (new Set(group.map((item) => item.role)).size < 2) continue;
    const first = group[0].issue;
    const directions = group.map((item) => item.issue.direction);
    const issueReferences = group.map(reference);

    if (hasOpposingDirections(group)) {
      conflicts.push({
        id,
        nodeId: first.nodeId!,
        nodeName: first.nodeName ?? first.nodeId!,
        aspect: first.aspect,
        reason: "不同角色针对同一设计属性提出了不能同时执行的修改方向。",
        issues: issueReferences,
      });
      continue;
    }

    const uniqueDirections = new Set(directions);
    const ranks = group.map((item) => severityRank[item.issue.severity]);
    const hasLargeSeverityGap = Math.max(...ranks) - Math.min(...ranks) >= 2;

    if (uniqueDirections.size === 1 && hasLargeSeverityGap) {
      differences.push({
        id,
        nodeId: first.nodeId!,
        nodeName: first.nodeName ?? first.nodeId!,
        aspect: first.aspect,
        reason: "角色认同同一问题和修改方向，但对严重程度的判断相差两档。",
        issues: issueReferences,
      });
      continue;
    }

    if (uniqueDirections.size === 1) {
      consensus.push({
        id,
        nodeId: first.nodeId!,
        nodeName: first.nodeName ?? first.nodeId!,
        aspect: first.aspect,
        direction: directions[0],
        issues: issueReferences,
      });
    }
  }

  return { consensus, differences, conflicts };
}

export function calculateCompositeScore(
  reviews: readonly AgentReview[],
): CompositeScore {
  const available: Array<{ source: ReviewerRole; score: number }> = [];
  for (const review of reviews) {
    if (review.status === "completed") available.push({ source: review.role, score: review.score });
  }
  const weightTotal = available.reduce((total, item) => total + sourceWeights[item.source], 0);
  if (weightTotal === 0) return { score: null, incomplete: true, components: [] };

  const components = available.map((item) => ({
    ...item,
    configuredWeight: sourceWeights[item.source],
    appliedWeight: sourceWeights[item.source] / weightTotal,
  }));
  return {
    score: Math.round(components.reduce((total, item) => total + item.score * item.appliedWeight, 0)),
    incomplete: available.length < 3,
    components,
  };
}
