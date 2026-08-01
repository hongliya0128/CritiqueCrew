import type { ReviewAnnotationIssue } from "./annotations";

export type ScanScope = "selection" | "page";

export type SelectionSummary = {
  count: number;
  names: string[];
  selectedNodeId: string | null;
  canScanSelection: boolean;
  pageId: string;
  pageName: string;
};

export type SolidColorSnapshot = {
  r: number;
  g: number;
  b: number;
  a: number;
};

export type FillKind = "none" | "solid" | "complex";

export type NodeSnapshot = {
  id: string;
  parentId: string | null;
  childIds: string[];
  name: string;
  type: string;
  depth: number;
  visible: boolean;
  locked: boolean;
  x: number;
  y: number;
  absoluteX: number | null;
  absoluteY: number | null;
  width: number;
  height: number;
  rotation: number;
  opacity: number;
  fills: SolidColorSnapshot[];
  fillKind: FillKind;
  hasPointerInteraction: boolean;
  fontSize: number | "mixed" | null;
  characters: string | null;
  cornerRadius: number | "mixed" | null;
};

export type ScanResult = {
  scope: ScanScope;
  rootId: string;
  rootName: string;
  rootType: string;
  pageId?: string;
  pageName?: string;
  nodeCount: number;
  nodes: NodeSnapshot[];
  truncated: boolean;
  screenshotBase64?: string;
  scannedAt: string;
};

export type RuleId = "color-contrast" | "font-size" | "target-size";

export type RuleSeverity = "error" | "warning";

export type RuleIssue = {
  id: string;
  ruleId: RuleId;
  severity: RuleSeverity;
  nodeId: string;
  nodeName: string;
  nodeType: string;
  message: string;
  actual: string;
  expected: string;
};

export type RuleCheckResult = {
  issues: RuleIssue[];
  skippedContrastNodes: number;
};

export type PluginMessage =
  | { type: "UI_READY" }
  | { type: "SCAN_REQUEST"; scope: ScanScope }
  | { type: "LOCATE_NODE"; nodeId: string }
  | { type: "LOCATE_SCOPE"; rootId: string }
  | { type: "CLEAR_NODE_FOCUS" }
  | { type: "CREATE_ANNOTATIONS"; issues: RuleIssue[] }
  | { type: "CLEAR_ANNOTATIONS" }
  | { type: "CREATE_REVIEW_ANNOTATIONS"; issues: ReviewAnnotationIssue[] }
  | { type: "CLEAR_REVIEW_ANNOTATIONS"; silent?: boolean }
  | { type: "REPAIR_SELECTED_FRAME_HIERARCHY" }
  | { type: "CLOSE_PLUGIN" };

export type UIMessage =
  | { type: "SELECTION_CHANGED"; selection: SelectionSummary }
  | { type: "SCAN_RESULT"; result: ScanResult }
  | { type: "NODE_LOCATED"; nodeId: string; nodeName: string }
  | { type: "SCOPE_LOCATED"; rootId: string; rootName: string }
  | { type: "NODE_FOCUS_CLEARED" }
  | { type: "ANNOTATIONS_CREATED"; count: number; nodeIds: string[] }
  | { type: "ANNOTATIONS_CLEARED"; count: number }
  | { type: "REVIEW_ANNOTATIONS_CREATED"; count: number; nodeIds: string[] }
  | { type: "REVIEW_ANNOTATIONS_CLEARED"; count: number }
  | { type: "HIERARCHY_REPAIRED"; movedCount: number }
  | { type: "PLUGIN_ERROR"; message: string };
