import type { PluginMessage, SelectionSummary, UIMessage } from "../shared/messages";
import { isSupportedSelectionRoot, scanScope } from "./scanner";

declare const __html__: string;

figma.showUI(__html__, { width: 420, height: 560, themeColors: true });

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
    case "CLOSE_PLUGIN":
      figma.closePlugin();
      break;
  }
};
