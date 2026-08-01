import type { NodeSnapshot, RuleCheckResult, ScanResult } from "./messages";
import type { ReviewBasisId } from "./review-basis";

export const REVIEWER_ROLES = ["visual", "accessibility", "interaction"] as const;
export type ReviewerRole = (typeof REVIEWER_ROLES)[number];
export type ReviewSeverity = "high" | "medium" | "low";
export type ReviewStatus = "completed" | "failed";
export const REVIEW_ASPECTS = [
  "visual-prominence",
  "information-density",
  "readability",
  "interaction-entry",
  "status-feedback",
  "error-prevention",
  "other",
] as const;
export type ReviewAspect = (typeof REVIEW_ASPECTS)[number];
export const REVIEW_DIRECTIONS = [
  "strengthen",
  "weaken",
  "add",
  "remove",
  "retain",
  "restructure",
  "unspecified",
] as const;
export type ReviewDirection = (typeof REVIEW_DIRECTIONS)[number];

export type ReviewIssue = {
  id: string;
  nodeId: string | null;
  nodeName: string | null;
  relatedNodes: Array<{
    nodeId: string;
    nodeName: string;
  }>;
  severity: ReviewSeverity;
  criterion: string;
  aspect: ReviewAspect;
  direction: ReviewDirection;
  title: string;
  evidence: string;
  basisIds: ReviewBasisId[];
  explanation: string;
  suggestion: string;
};

export type ReviewIssueReference = {
  role: ReviewerRole;
  issueId: string;
  severity: ReviewSeverity;
  direction: ReviewDirection;
  title: string;
  evidence: string;
  explanation: string;
  suggestion: string;
};

export type ReviewConsensus = {
  id: string;
  nodeId: string;
  nodeName: string;
  aspect: ReviewAspect;
  direction: ReviewDirection;
  issues: ReviewIssueReference[];
};

export type ReviewDifference = {
  id: string;
  nodeId: string;
  nodeName: string;
  aspect: ReviewAspect;
  reason: string;
  issues: ReviewIssueReference[];
};

export type ReviewConflict = {
  id: string;
  nodeId: string;
  nodeName: string;
  aspect: ReviewAspect;
  reason: string;
  issues: ReviewIssueReference[];
};

export type ArbitrationDecision = {
  conflictId: string;
  priority: ReviewSeverity;
  resolution: string;
  rationale: string;
  preferredIssueIds: string[];
};

export type ArbitrationResult = {
  status: "not-needed" | "completed" | "failed" | "skipped";
  consensus: ReviewConsensus[];
  differences: ReviewDifference[];
  conflicts: ReviewConflict[];
  decisions: ArbitrationDecision[];
  summary: string;
  latencyMs: number;
  error: string | null;
};

export type CompositeScoreComponent = {
  source: ReviewerRole;
  score: number;
  configuredWeight: number;
  appliedWeight: number;
};

export type CompositeScore = {
  score: number | null;
  incomplete: boolean;
  components: CompositeScoreComponent[];
};

export type ReviewDimension = {
  label: string;
  score: number;
  observation: string;
};

export type AgentReview = {
  role: ReviewerRole;
  focus: string;
  score: number;
  dimensions: ReviewDimension[];
  summary: string;
  issues: ReviewIssue[];
  status: ReviewStatus;
  latencyMs: number;
  error: string | null;
};

export type ReviewRequest = {
  scan: Pick<ScanResult, "scope" | "rootId" | "rootName" | "rootType" | "nodeCount" | "truncated"> & {
    nodes: NodeSnapshot[];
  };
  rules: RuleCheckResult;
  screenshotBase64?: string;
};

export type ReviewResponse = {
  reviews: AgentReview[];
  arbitration: ArbitrationResult;
  compositeScore: CompositeScore;
  incomplete: boolean;
  elapsedMs: number;
  mock: boolean;
};
