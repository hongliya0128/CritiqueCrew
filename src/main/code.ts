import type { PluginMessage, RuleIssue, SelectionSummary, UIMessage } from "../shared/messages";
import { aggregateReviewAnnotations } from "../shared/annotations";
import type { ReviewSeverity } from "../shared/review";
import { isSupportedSelectionRoot, scanScope } from "./scanner";

declare const __html__: string;
declare function btoa(value: string): string;

figma.showUI(__html__, { width: 420, height: 560, themeColors: true });

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
  // 1200px is sufficient for the mobile and panel-sized UI fixtures while reducing multimodal upload and inference time.
  const bytes = await node.exportAsync({ format: "PNG", constraint: { type: "WIDTH", value: 1200 } });
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

async function createAnnotations(issues: readonly RuleIssue[]): Promise<string[]> {
  clearAnnotations("rule");
  const markers: RectangleNode[] = [];
  const annotatedNodeIds: string[] = [];
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
    annotatedNodeIds.push(issue.nodeId);
  }

  if (markers.length === 0) return [];

  const group = figma.group(markers, figma.currentPage);
  group.name = "CritiqueCrew · 规则问题标注（可清除）";
  group.setPluginData(ANNOTATION_ROOT_KEY, "true");
  group.setPluginData(ANNOTATION_SOURCE_KEY, "rule");
  group.locked = true;
  return annotatedNodeIds;
}

function reviewSeverityColor(severity: ReviewSeverity): RGB {
  if (severity === "high") return { r: 0.843, g: 0.149, b: 0.239 };
  if (severity === "medium") return { r: 0.949, g: 0.663, b: 0 };
  return { r: 0.29, g: 0.53, b: 0.85 };
}

async function createReviewAnnotations(
  issues: Parameters<typeof aggregateReviewAnnotations>[0],
): Promise<string[]> {
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

  if (resolvedTargets.length === 0) return [];

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
  return resolvedTargets.map(({ target }) => target.nodeId);
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
        const nodeIds = await createAnnotations(message.issues);
        post({ type: "ANNOTATIONS_CREATED", count: nodeIds.length, nodeIds });
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
        const nodeIds = await createReviewAnnotations(message.issues);
        post({ type: "REVIEW_ANNOTATIONS_CREATED", count: nodeIds.length, nodeIds });
      } catch (error) {
        post({
          type: "PLUGIN_ERROR",
          message: error instanceof Error ? error.message : "创建 AI 评审标注失败，请重试。",
        });
      }
      break;
    case "CLEAR_REVIEW_ANNOTATIONS":
      {
        const count = clearAnnotations("review");
        if (!message.silent) post({ type: "REVIEW_ANNOTATIONS_CLEARED", count });
      }
      break;
    case "CLOSE_PLUGIN":
      figma.closePlugin();
      break;
  }
};
