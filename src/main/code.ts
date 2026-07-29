import type { PluginMessage, SelectionSummary, UIMessage } from "../shared/messages";
import { isSupportedSelectionRoot, scanScope } from "./scanner";

declare const __html__: string;

figma.showUI(__html__, { width: 420, height: 560, themeColors: true });

const PROTOTYPE_ROOT_NAMES = new Set([
  "健康管理 App - CritiqueCrew 测试页",
  "预约详情 - 原型目标",
]);
const EXPLICIT_PARENT_BY_CHILD = new Map<string, string>([
  ["问候标题", "顶部问候区"],
  ["今日日期", "顶部问候区"],
  ["个人头像", "顶部问候区"],
  ["健康评分标题", "健康评分卡片"],
  ["健康评分说明", "健康评分卡片"],
  ["健康评分圆环", "健康评分卡片"],
  ["健康评分数值", "健康评分卡片"],
  ["预约标题", "最近预约卡片"],
  ["预约详情", "最近预约卡片"],
  ["说明文字-12px-故意不合格", "最近预约卡片"],
  ["症状输入框提示", "症状输入框"],
  ["确认预约按钮（40x40-故意不合格）", "症状输入框"],
]);

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

function repairPrototypeHierarchy(): number {
  let movedCount = 0;
  const roots = figma.currentPage.children.filter(
    (node): node is FrameNode => node.type === "FRAME" && PROTOTYPE_ROOT_NAMES.has(node.name),
  );

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

    for (const [childName, parentName] of EXPLICIT_PARENT_BY_CHILD) {
      const child = root.findOne((node) => node.name === childName);
      const parent = root.findOne((node) => node.name === parentName);
      if (
        child &&
        parent &&
        canContainChildren(parent) &&
        child !== parent &&
        reparentPreservingPosition(child, parent)
      ) {
        movedCount += 1;
      }
    }
  }

  return movedCount;
}

function getSelectionSummary(): SelectionSummary {
  const selection = figma.currentPage.selection;
  return {
    count: selection.length,
    names: selection.slice(0, 3).map((node) => node.name),
    canScanSelection: selection.length === 1 && isSupportedSelectionRoot(selection[0]),
  };
}

function post(message: UIMessage): void {
  figma.ui.postMessage(message);
}

function sendSelection(): void {
  post({ type: "SELECTION_CHANGED", selection: getSelectionSummary() });
}

figma.on("selectionchange", sendSelection);

figma.ui.onmessage = (message: PluginMessage) => {
  switch (message.type) {
    case "UI_READY":
      sendSelection();
      break;
    case "SCAN_REQUEST":
      try {
        post({ type: "SCAN_RESULT", result: scanScope(message.scope) });
      } catch (error) {
        post({
          type: "PLUGIN_ERROR",
          message: error instanceof Error ? error.message : "扫描失败，请重试。",
        });
      }
      break;
    case "REPAIR_PROTOTYPE_HIERARCHY": {
      const movedCount = repairPrototypeHierarchy();
      figma.notify(
        movedCount > 0
          ? `已调整两页原型层级，共归入 ${movedCount} 个节点。`
          : "两页原型当前已是目标层级。",
      );
      post({ type: "HIERARCHY_REPAIRED", movedCount });
      break;
    }
    case "CLOSE_PLUGIN":
      figma.closePlugin();
      break;
  }
};
