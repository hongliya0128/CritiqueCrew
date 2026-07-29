export type ScanScope = "selection" | "page";

export type SelectionSummary = {
  count: number;
  names: string[];
  selectedNodeId: string | null;
  canScanSelection: boolean;
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
  nodeCount: number;
  nodes: NodeSnapshot[];
  truncated: boolean;
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

export type RuleScoreItem = {
  ruleId: RuleId;
  checked: number;
  passed: number;
  failed: number;
  score: number | null;
};

export type RuleCheckResult = {
  issues: RuleIssue[];
  skippedContrastNodes: number;
  score: number | null;
  scoreItems: RuleScoreItem[];
};

export type PluginMessage =
  | { type: "UI_READY" }
  | { type: "SCAN_REQUEST"; scope: ScanScope }
  | { type: "LOCATE_NODE"; nodeId: string }
  | { type: "CLEAR_NODE_FOCUS" }
  | { type: "CREATE_ANNOTATIONS"; issues: RuleIssue[] }
  | { type: "CLEAR_ANNOTATIONS" }
  | { type: "REPAIR_PROTOTYPE_HIERARCHY" }
  | { type: "CLOSE_PLUGIN" };

export type UIMessage =
  | { type: "SELECTION_CHANGED"; selection: SelectionSummary }
  | { type: "SCAN_RESULT"; result: ScanResult }
  | { type: "NODE_LOCATED"; nodeId: string; nodeName: string }
  | { type: "NODE_FOCUS_CLEARED" }
  | { type: "ANNOTATIONS_CREATED"; count: number }
  | { type: "ANNOTATIONS_CLEARED"; count: number }
  | { type: "HIERARCHY_REPAIRED"; movedCount: number }
  | { type: "PLUGIN_ERROR"; message: string };
