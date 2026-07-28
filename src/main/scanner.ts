import type {
  NodeSnapshot,
  ScanResult,
  ScanScope,
  SolidColorSnapshot,
} from "../shared/messages";

export const MAX_VISIBLE_NODES = 600;
export const MAX_TEXT_LENGTH = 300;

const selectableRootTypes = new Set<SceneNode["type"]>([
  "FRAME",
  "COMPONENT",
  "INSTANCE",
  "SECTION",
]);

export function isSupportedSelectionRoot(node: SceneNode): boolean {
  return selectableRootTypes.has(node.type);
}

function rounded(value: number): number {
  return Math.round(value * 100) / 100;
}

function mixedNumber(value: unknown): number | "mixed" | null {
  if (typeof value === "number") return rounded(value);
  if (typeof value === "symbol") return "mixed";
  return null;
}

function solidFills(node: SceneNode): SolidColorSnapshot[] {
  if (!("fills" in node) || !Array.isArray(node.fills)) return [];

  return node.fills
    .filter((paint): paint is SolidPaint => paint.type === "SOLID" && paint.visible !== false)
    .map((paint) => ({
      r: rounded(paint.color.r),
      g: rounded(paint.color.g),
      b: rounded(paint.color.b),
      a: rounded(paint.opacity ?? 1),
    }));
}

function visibleChildren(node: SceneNode): readonly SceneNode[] {
  if (!("children" in node)) return [];
  return node.children.filter((child) => child.visible !== false);
}

function snapshotNode(node: SceneNode, parentId: string | null, depth: number): NodeSnapshot {
  const bounds = node.absoluteBoundingBox;
  const children = visibleChildren(node);
  const isText = node.type === "TEXT";

  return {
    id: node.id,
    parentId,
    childIds: children.map((child) => child.id),
    name: node.name,
    type: node.type,
    depth,
    visible: node.visible !== false,
    locked: node.locked,
    x: rounded(node.x),
    y: rounded(node.y),
    absoluteX: bounds ? rounded(bounds.x) : null,
    absoluteY: bounds ? rounded(bounds.y) : null,
    width: rounded(node.width),
    height: rounded(node.height),
    rotation: "rotation" in node ? rounded(node.rotation) : 0,
    opacity: "opacity" in node ? rounded(node.opacity) : 1,
    fills: solidFills(node),
    fontSize: isText ? mixedNumber(node.fontSize) : null,
    characters: isText ? node.characters.slice(0, MAX_TEXT_LENGTH) : null,
    cornerRadius: "cornerRadius" in node ? mixedNumber(node.cornerRadius) : null,
  };
}

export function scanNodeTree(
  roots: readonly SceneNode[],
  limit = MAX_VISIBLE_NODES,
): { nodes: NodeSnapshot[]; truncated: boolean } {
  const nodes: NodeSnapshot[] = [];
  let truncated = false;

  function visit(node: SceneNode, parentId: string | null, depth: number): void {
    if (node.visible === false) return;
    if (nodes.length >= limit) {
      truncated = true;
      return;
    }

    nodes.push(snapshotNode(node, parentId, depth));
    for (const child of visibleChildren(node)) {
      visit(child, node.id, depth + 1);
      if (nodes.length >= limit) {
        if (visibleChildren(node).some((candidate) => !nodes.some((item) => item.id === candidate.id))) {
          truncated = true;
        }
        break;
      }
    }
  }

  for (const root of roots) {
    visit(root, null, 0);
    if (nodes.length >= limit) {
      if (roots.some((candidate) => !nodes.some((item) => item.id === candidate.id))) truncated = true;
      break;
    }
  }

  return { nodes, truncated };
}

export function scanScope(scope: ScanScope): ScanResult {
  let roots: readonly SceneNode[];
  let rootId: string;
  let rootName: string;
  let rootType: string;

  if (scope === "selection") {
    const selection = figma.currentPage.selection;
    if (selection.length !== 1 || !isSupportedSelectionRoot(selection[0])) {
      throw new Error("请选择一个 Frame、Component、Instance 或 Section 后再扫描。");
    }
    roots = selection;
    rootId = selection[0].id;
    rootName = selection[0].name;
    rootType = selection[0].type;
  } else {
    roots = figma.currentPage.children;
    rootId = figma.currentPage.id;
    rootName = figma.currentPage.name;
    rootType = "PAGE";
  }

  const result = scanNodeTree(roots);
  return {
    scope,
    rootId,
    rootName,
    rootType,
    nodeCount: result.nodes.length,
    nodes: result.nodes,
    truncated: result.truncated,
    scannedAt: new Date().toISOString(),
  };
}
