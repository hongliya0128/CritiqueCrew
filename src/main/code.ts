import type { PluginMessage, RuleIssue, SelectionSummary, UIMessage } from "../shared/messages";
import { aggregateReviewAnnotations } from "../shared/annotations";
import type { ReviewSeverity } from "../shared/review";
import { isSupportedSelectionRoot, scanScope } from "./scanner";

declare const __html__: string;
declare function btoa(value: string): string;

figma.showUI(__html__, { width: 420, height: 560, themeColors: true });

function canContainChildren(node: SceneNode): node is FrameNode | ComponentNode | SectionNode {
  return node.type === "FRAME" || node.type === "COMPONENT" || node.type === "SECTION";
}

function containsBounds(outer: Rect, inner: Rect): boolean {
  const tolerance = 0.5;
  return (
    inner.x >= outer.x - tolerance &&
    inner.y >= outer.y - tolerance &&
    inner.x + inner.width <= outer.x + outer.width + tolerance &&
    inner.y + inner.height <= outer.y + outer.height + tolerance
  );
}

function reparentPreservingPosition(
  node: SceneNode,
  parent: FrameNode | ComponentNode | SectionNode,
): boolean {
  if (node.parent === parent) return false;
  const nodeBounds = node.absoluteBoundingBox;
  const parentBounds = parent.absoluteBoundingBox;
  if (!nodeBounds || !parentBounds) return false;

  parent.appendChild(node);
  node.x = nodeBounds.x - parentBounds.x;
  node.y = nodeBounds.y - parentBounds.y;
  return true;
}

function repairSelectedFrameHierarchy(): number {
  const selection = figma.currentPage.selection;
  if (selection.length !== 1 || selection[0].type !== "FRAME") {
    throw new Error("请先在画布中选择一个需要整理的 Frame。");
  }

  let movedCount = 0;
  const roots = [selection[0]];

  for (const root of roots) {
    const siblings = [...root.children];
    const assignments = siblings
      .map((node) => {
        const nodeBounds = node.absoluteBoundingBox;
        if (!nodeBounds) return null;

        const parent = siblings
          .filter(canContainChildren)
          .filter((candidate) => candidate !== node)
          .filter((candidate) => {
            const candidateBounds = candidate.absoluteBoundingBox;
            if (!candidateBounds || !containsBounds(candidateBounds, nodeBounds)) return false;
            return candidateBounds.width * candidateBounds.height >
              nodeBounds.width * nodeBounds.height + 0.5;
          })
          .sort((left, right) => {
            const leftBounds = left.absoluteBoundingBox!;
            const rightBounds = right.absoluteBoundingBox!;
            return (
              leftBounds.width * leftBounds.height -
              rightBounds.width * rightBounds.height
            );
          })[0];

        return parent ? { node, parent } : null;
      })
      .filter(
        (assignment): assignment is { node: SceneNode; parent: FrameNode | ComponentNode | SectionNode } =>
          assignment !== null,
      );

    for (const { node, parent } of assignments) {
      if (reparentPreservingPosition(node, parent)) movedCount += 1;
    }

  }

  return movedCount;
}

function getSelectionSummary(): SelectionSummary {
  const selection = figma.currentPage.selection;
  return {
    count: selection.length,
    names: selection.slice(0, 3).map((node) => node.name),
    selectedNodeId: selection.length === 1 ? selection[0].id : null,
    canScanSelection: selection.length === 1 && isSupportedSelectionRoot(selection[0]),
    pageId: figma.currentPage.id,
    pageName: figma.currentPage.name,
  };
}

function post(message: UIMessage): void {
  figma.ui.postMessage(message);
}

function sendSelection(): void {
  post({ type: "SELECTION_CHANGED", selection: getSelectionSummary() });
}

function isSceneNode(node: BaseNode): node is SceneNode {
  return node.type !== "DOCUMENT" && node.type !== "PAGE";
}

async function locateNode(nodeId: string): Promise<void> {
  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node || !isSceneNode(node)) {
    throw new Error("未找到该节点；它可能已被删除，或不在当前页面中。");
  }

  figma.currentPage.selection = [node];
  figma.viewport.scrollAndZoomIntoView([node]);
  post({ type: "NODE_LOCATED", nodeId, nodeName: node.name });
}

async function locateScope(rootId: string): Promise<void> {
  const node = await figma.getNodeByIdAsync(rootId);
  if (!node) {
    throw new Error("未找到本次评估范围；它可能已被删除。");
  }

  if (node.type === "PAGE") {
    await figma.setCurrentPageAsync(node);
    figma.currentPage.selection = [];
    const visibleChildren = node.children.filter((child) => child.visible !== false);
    if (visibleChildren.length > 0) {
      figma.viewport.scrollAndZoomIntoView(visibleChildren);
    }
    post({ type: "SCOPE_LOCATED", rootId, rootName: node.name });
    return;
  }

  if (!isSceneNode(node)) {
    throw new Error("该评估范围无法在画布中定位。");
  }

  if (node.parent?.type === "PAGE" && node.parent !== figma.currentPage) {
    await figma.setCurrentPageAsync(node.parent);
  }
  figma.currentPage.selection = [node];
  figma.viewport.scrollAndZoomIntoView([node]);
  post({ type: "SCOPE_LOCATED", rootId, rootName: node.name });
}

function clearNodeFocus(): void {
  figma.currentPage.selection = [];
  post({ type: "NODE_FOCUS_CLEARED" });
}

function bytesToBase64(bytes: Uint8Array): string {
  let result = "";
  const chunkSize = 8192;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    result += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(result);
}

async function attachScreenshot(result: import("../shared/messages").ScanResult): Promise<void> {
  if (result.scope !== "selection") return;
  const node = await figma.getNodeByIdAsync(result.rootId);
  if (!node || !isSceneNode(node) || !("exportAsync" in node)) return;
  const bytes = await node.exportAsync({ format: "PNG", constraint: { type: "WIDTH", value: 1600 } });
  // Keep the JSON request below the local proxy limit; text-only review remains available for larger canvases.
  if (bytes.byteLength <= 3 * 1024 * 1024) result.screenshotBase64 = bytesToBase64(bytes);
}

const ANNOTATION_ROOT_KEY = "critiquecrew-annotation-root";
const ANNOTATION_SOURCE_KEY = "critiquecrew-annotation-source";
type AnnotationSource = "rule" | "review";

function annotationRoots(source?: AnnotationSource): SceneNode[] {
  return figma.currentPage.findAll(
    (node) => {
      if (node.getPluginData(ANNOTATION_ROOT_KEY) !== "true") return false;
      if (!source) return true;
      const savedSource = node.getPluginData(ANNOTATION_SOURCE_KEY);
      return savedSource === source || (source === "rule" && savedSource === "");
    },
  );
}

function clearAnnotations(source?: AnnotationSource): number {
  const roots = annotationRoots(source);
  for (const root of roots) root.remove();
  return roots.length;
}

// Canvas annotations are temporary UI, not part of the user's design.
figma.on("close", () => {
  clearAnnotations();
});

function annotationColor(severity: RuleIssue["severity"]): RGB {
  return severity === "error" ? { r: 0.88, g: 0.18, b: 0.24 } : { r: 0.93, g: 0.56, b: 0.04 };
}

async function createAnnotations(issues: readonly RuleIssue[]): Promise<number> {
  clearAnnotations("rule");
  const markers: RectangleNode[] = [];
  const seenNodeIds = new Set<string>();

  for (const issue of issues) {
    if (seenNodeIds.has(issue.nodeId)) continue;
    seenNodeIds.add(issue.nodeId);

    const node = await figma.getNodeByIdAsync(issue.nodeId);
    if (!node || !isSceneNode(node) || !node.absoluteBoundingBox) continue;

    const bounds = node.absoluteBoundingBox;
    const marker = figma.createRectangle();
    marker.name = `CritiqueCrew 标注 · ${issue.nodeName}`;
    marker.x = bounds.x - 3;
    marker.y = bounds.y - 3;
    marker.resizeWithoutConstraints(bounds.width + 6, bounds.height + 6);
    marker.fills = [];
    marker.strokes = [{ type: "SOLID", color: annotationColor(issue.severity) }];
    marker.strokeWeight = 2;
    marker.cornerRadius = 4;
    marker.locked = true;
    markers.push(marker);
  }

  if (markers.length === 0) return 0;

  const group = figma.group(markers, figma.currentPage);
  group.name = "CritiqueCrew · 规则问题标注（可清除）";
  group.setPluginData(ANNOTATION_ROOT_KEY, "true");
  group.setPluginData(ANNOTATION_SOURCE_KEY, "rule");
  group.locked = true;
  return markers.length;
}

function reviewSeverityColor(severity: ReviewSeverity): RGB {
  if (severity === "high") return { r: 0.843, g: 0.149, b: 0.239 };
  if (severity === "medium") return { r: 0.949, g: 0.663, b: 0 };
  return { r: 0.29, g: 0.53, b: 0.85 };
}

async function createReviewAnnotations(
  issues: Parameters<typeof aggregateReviewAnnotations>[0],
): Promise<number> {
  const targets = aggregateReviewAnnotations(issues);
  const resolvedTargets: Array<{
    target: (typeof targets)[number];
    node: SceneNode;
  }> = [];

  for (const target of targets) {
    const node = await figma.getNodeByIdAsync(target.nodeId);
    if (!node || !isSceneNode(node) || !node.absoluteBoundingBox) continue;
    resolvedTargets.push({ target, node });
  }

  if (resolvedTargets.length === 0) return 0;

  let targetPage: PageNode | null = resolvedTargets[0].node.parent?.type === "PAGE"
    ? resolvedTargets[0].node.parent
    : null;
  let ancestor: BaseNode | null = resolvedTargets[0].node.parent;
  while (!targetPage && ancestor) {
    if (ancestor.type === "PAGE") targetPage = ancestor;
    ancestor = ancestor.parent;
  }
  if (targetPage && targetPage !== figma.currentPage) {
    await figma.setCurrentPageAsync(targetPage);
  }
  clearAnnotations("review");

  const annotationNodes: SceneNode[] = [];
  for (const { target, node } of resolvedTargets) {
    const bounds = node.absoluteBoundingBox!;
    const marker = figma.createRectangle();
    marker.name = `CritiqueCrew AI 标注 · ${target.nodeName}`;
    marker.x = bounds.x - 4;
    marker.y = bounds.y - 4;
    marker.resizeWithoutConstraints(bounds.width + 8, bounds.height + 8);
    marker.fills = [];
    marker.strokes = [{ type: "SOLID", color: reviewSeverityColor(target.severity) }];
    marker.strokeWeight = 2;
    marker.dashPattern = [8, 4];
    marker.cornerRadius = 5;
    annotationNodes.push(marker);
  }

  const group = figma.group(annotationNodes, figma.currentPage);
  group.name = "CritiqueCrew · AI 评审问题标注（优先级虚线）";
  group.setPluginData(ANNOTATION_ROOT_KEY, "true");
  group.setPluginData(ANNOTATION_SOURCE_KEY, "review");
  group.locked = true;
  return resolvedTargets.length;
}

figma.on("selectionchange", sendSelection);
figma.on("currentpagechange", sendSelection);

figma.ui.onmessage = async (message: PluginMessage) => {
  switch (message.type) {
    case "UI_READY":
      sendSelection();
      break;
    case "SCAN_REQUEST":
      try {
        // Annotations describe a previous scan and must never survive into a new result set.
        clearAnnotations();
        const result = scanScope(message.scope);
        await attachScreenshot(result);
        post({ type: "SCAN_RESULT", result });
      } catch (error) {
        post({
          type: "PLUGIN_ERROR",
          message: error instanceof Error ? error.message : "扫描失败，请重试。",
        });
      }
      break;
    case "LOCATE_NODE":
      try {
        await locateNode(message.nodeId);
      } catch (error) {
        post({
          type: "PLUGIN_ERROR",
          message: error instanceof Error ? error.message : "定位节点失败，请重试。",
        });
      }
      break;
    case "LOCATE_SCOPE":
      try {
        await locateScope(message.rootId);
      } catch (error) {
        post({
          type: "PLUGIN_ERROR",
          message: error instanceof Error ? error.message : "定位评估范围失败，请重试。",
        });
      }
      break;
    case "CLEAR_NODE_FOCUS":
      clearNodeFocus();
      break;
    case "CREATE_ANNOTATIONS":
      try {
        const count = await createAnnotations(message.issues);
        post({ type: "ANNOTATIONS_CREATED", count });
      } catch (error) {
        post({
          type: "PLUGIN_ERROR",
          message: error instanceof Error ? error.message : "创建画布标注失败，请重试。",
        });
      }
      break;
    case "CLEAR_ANNOTATIONS":
      post({ type: "ANNOTATIONS_CLEARED", count: clearAnnotations("rule") });
      break;
    case "CREATE_REVIEW_ANNOTATIONS":
      try {
        const count = await createReviewAnnotations(message.issues);
        post({ type: "REVIEW_ANNOTATIONS_CREATED", count });
      } catch (error) {
        post({
          type: "PLUGIN_ERROR",
          message: error instanceof Error ? error.message : "创建 AI 评审标注失败，请重试。",
        });
      }
      break;
    case "CLEAR_REVIEW_ANNOTATIONS":
      post({ type: "REVIEW_ANNOTATIONS_CLEARED", count: clearAnnotations("review") });
      break;
    case "REPAIR_SELECTED_FRAME_HIERARCHY":
      try {
        const movedCount = repairSelectedFrameHierarchy();
        figma.notify(
          movedCount > 0
            ? `已整理选中 Frame 的层级，共调整 ${movedCount} 个节点。`
            : "选中 Frame 当前没有需要整理的层级。",
        );
        post({ type: "HIERARCHY_REPAIRED", movedCount });
      } catch (error) {
        post({
          type: "PLUGIN_ERROR",
          message: error instanceof Error ? error.message : "整理选中 Frame 层级失败，请重试。",
        });
      }
      break;
    case "CLOSE_PLUGIN":
      figma.closePlugin();
      break;
  }
};
