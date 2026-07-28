export type ScanScope = "selection" | "page";

export type SelectionSummary = {
  count: number;
  names: string[];
  canScanSelection: boolean;
};

export type SolidColorSnapshot = {
  r: number;
  g: number;
  b: number;
  a: number;
};

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

export type PluginMessage =
  | { type: "UI_READY" }
  | { type: "SCAN_REQUEST"; scope: ScanScope }
  | { type: "CLOSE_PLUGIN" };

export type UIMessage =
  | { type: "SELECTION_CHANGED"; selection: SelectionSummary }
  | { type: "SCAN_RESULT"; result: ScanResult }
  | { type: "PLUGIN_ERROR"; message: string };
