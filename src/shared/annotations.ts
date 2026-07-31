import type { AgentReview, ReviewerRole, ReviewIssue, ReviewSeverity } from "./review";

export type ReviewAnnotationIssue = {
  nodeId: string;
  nodeName: string;
  role: ReviewerRole;
  severity: ReviewSeverity;
  screenLevel: boolean;
};

export type ReviewAnnotationTarget = {
  nodeId: string;
  nodeName: string;
  roles: ReviewerRole[];
  severity: ReviewSeverity;
  screenLevel: boolean;
};

export type ReviewIssueMatch = {
  role: ReviewerRole;
  issue: ReviewIssue;
};

const severityRank: Record<ReviewSeverity, number> = {
  high: 3,
  medium: 2,
  low: 1,
};

export function aggregateReviewAnnotations(
  issues: readonly ReviewAnnotationIssue[],
): ReviewAnnotationTarget[] {
  const targets = new Map<string, ReviewAnnotationTarget>();

  for (const issue of issues) {
    const existing = targets.get(issue.nodeId);
    if (!existing) {
      targets.set(issue.nodeId, {
        nodeId: issue.nodeId,
        nodeName: issue.nodeName,
        roles: [issue.role],
        severity: issue.severity,
        screenLevel: issue.screenLevel,
      });
      continue;
    }

    if (!existing.roles.includes(issue.role)) existing.roles.push(issue.role);
    if (severityRank[issue.severity] > severityRank[existing.severity]) {
      existing.severity = issue.severity;
    }
    existing.screenLevel ||= issue.screenLevel;
  }

  return [...targets.values()];
}

export function findHighestPriorityReviewIssue(
  reviews: readonly AgentReview[],
  nodeId: string,
): ReviewIssueMatch | null {
  let bestMatch: ReviewIssueMatch | null = null;

  for (const review of reviews) {
    for (const issue of review.issues) {
      if (issue.nodeId !== nodeId) continue;
      if (!bestMatch || severityRank[issue.severity] > severityRank[bestMatch.issue.severity]) {
        bestMatch = { role: review.role, issue };
      }
    }
  }

  return bestMatch;
}
