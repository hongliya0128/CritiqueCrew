import type { NodeSnapshot, RuleCheckResult, ScanResult } from "./messages";
import type { ReviewBasisId } from "./review-basis";

export const REVIEWER_ROLES = ["visual", "accessibility", "interaction"] as const;
export type ReviewerRole = (typeof REVIEWER_ROLES)[number];
export type ReviewSeverity = "high" | "medium" | "low";
export type ReviewStatus = "completed" | "failed";

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
  title: string;
  evidence: string;
  basisIds: ReviewBasisId[];
  explanation: string;
  suggestion: string;
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
  incomplete: boolean;
  elapsedMs: number;
  mock: boolean;
};
