import type {
  NodeSnapshot,
  RuleCheckResult,
  RuleId,
  RuleIssue,
  SolidColorSnapshot,
} from "./messages";

export const WCAG_AA_CONTRAST_RATIO = 4.5;
export const MIN_BODY_FONT_SIZE = 14;
export const MIN_FUNCTIONAL_FONT_SIZE = 12;
export const MIN_AUXILIARY_FONT_SIZE = 11;
export const MIN_TARGET_SIZE = 44;

const interactiveNamePattern =
  /(?:button|btn|input|field|search|select|checkbox|radio|switch|tab|link|submit|cancel|登录|注册|保存|提交|确认|取消|按钮|输入|搜索|选择|开关|链接)/i;
const interactiveNodeTypes = new Set(["COMPONENT", "INSTANCE"]);
const interactiveContainerTypes = new Set(["FRAME", "GROUP", "COMPONENT", "INSTANCE"]);
const decorativeTextPattern = /(?:icon|glyph|arrow|chevron|avatar\s*initial|图标|箭头|头像首字母)/i;
const functionalTextPattern =
  /(?:navigation|nav\b|tab\b|badge|button\s*text|placeholder|shortcut|menu|导航|标签页|状态标签|徽标|按钮文本|输入框提示|占位|快捷入口|菜单)/i;
const auxiliaryTextPattern =
  /(?:system\s*status|status\s*bar|system\s*time|battery|signal|metadata|page\s*number|test\s*label|系统状态|状态栏|系统时间|电量|信号|辅助信息|元数据|今日日期|当前日期|页面编号|测试标签)/i;
const headingTextPattern = /(?:heading|title|标题)/i;
const metricTextPattern =
  /(?:metric|score\s*value|statistic|count|评分数值|指标数值|统计数值|数据值)/i;
const metricOnlyPattern = /^[\d\s.,:%+\-/]+$/;

type TextRole = "body" | "heading" | "functional" | "auxiliary" | "metric" | "decorative";

function channelToLinear(value: number): number {
  const channel = Math.max(0, Math.min(1, value));
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(color: SolidColorSnapshot): number {
  return (
    0.2126 * channelToLinear(color.r) +
    0.7152 * channelToLinear(color.g) +
    0.0722 * channelToLinear(color.b)
  );
}

function composite(foreground: SolidColorSnapshot, background: SolidColorSnapshot): SolidColorSnapshot {
  const alpha = foreground.a + background.a * (1 - foreground.a);
  if (alpha === 0) return { r: 0, g: 0, b: 0, a: 0 };

  return {
    r: (foreground.r * foreground.a + background.r * background.a * (1 - foreground.a)) / alpha,
    g: (foreground.g * foreground.a + background.g * background.a * (1 - foreground.a)) / alpha,
    b: (foreground.b * foreground.a + background.b * background.a * (1 - foreground.a)) / alpha,
    a: alpha,
  };
}

export function contrastRatio(foreground: SolidColorSnapshot, background: SolidColorSnapshot): number {
  const visibleForeground = foreground.a < 1 ? composite(foreground, background) : foreground;
  const lighter = Math.max(relativeLuminance(visibleForeground), relativeLuminance(background));
  const darker = Math.min(relativeLuminance(visibleForeground), relativeLuminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

function nearestBackground(node: NodeSnapshot, byId: Map<string, NodeSnapshot>): SolidColorSnapshot | null {
  let parentId = node.parentId;
  while (parentId) {
    const parent = byId.get(parentId);
    if (!parent) return null;
    if (parent.fillKind === "complex") return null;
    if (parent.fillKind === "solid") return parent.fills[0] ?? null;
    parentId = parent.parentId;
  }
  return null;
}

function isInteractiveCandidate(node: NodeSnapshot): boolean {
  if (!interactiveContainerTypes.has(node.type)) return false;
  return (
    node.hasPointerInteraction ||
    interactiveNodeTypes.has(node.type) ||
    interactiveNamePattern.test(node.name)
  );
}

function isDecorativeText(node: NodeSnapshot): boolean {
  return decorativeTextPattern.test(node.name);
}

function classifyTextRole(node: NodeSnapshot, byId: Map<string, NodeSnapshot>): TextRole {
  if (isDecorativeText(node)) return "decorative";
  if (auxiliaryTextPattern.test(node.name)) return "auxiliary";
  if (functionalTextPattern.test(node.name)) return "functional";
  if (headingTextPattern.test(node.name)) return "heading";
  if (metricTextPattern.test(node.name)) return "metric";

  let parentId = node.parentId;
  while (parentId) {
    const parent = byId.get(parentId);
    if (!parent) break;
    if (auxiliaryTextPattern.test(parent.name)) return "auxiliary";
    if (functionalTextPattern.test(parent.name) || isInteractiveCandidate(parent)) return "functional";
    if (headingTextPattern.test(parent.name)) return "heading";
    if (metricTextPattern.test(parent.name)) return "metric";
    parentId = parent.parentId;
  }

  const characters = node.characters?.trim() ?? "";
  if (characters.length > 0 && metricOnlyPattern.test(characters)) return "metric";
  return "body";
}

function minimumFontSizeForRole(role: TextRole): number | null {
  switch (role) {
    case "body":
    case "heading":
    case "metric":
      return MIN_BODY_FONT_SIZE;
    case "functional":
      return MIN_FUNCTIONAL_FONT_SIZE;
    case "auxiliary":
      return MIN_AUXILIARY_FONT_SIZE;
    case "decorative":
      return null;
  }
}

function fontSizeMessage(role: TextRole): string {
  switch (role) {
    case "functional":
      return "功能性界面文字字号小于最小要求";
    case "auxiliary":
      return "系统或辅助文字字号小于建议值";
    case "heading":
      return "标题文字字号小于最小要求";
    case "metric":
      return "指标数值字号小于最小要求";
    default:
      return "正文文本字号小于最小要求";
  }
}

function createIssue(
  ruleId: RuleId,
  node: NodeSnapshot,
  message: string,
  actual: string,
  expected: string,
  severity: RuleIssue["severity"] = "error",
): RuleIssue {
  return {
    id: `${ruleId}:${node.id}`,
    ruleId,
    severity,
    nodeId: node.id,
    nodeName: node.name,
    nodeType: node.type,
    message,
    actual,
    expected,
  };
}

export function checkRules(nodes: readonly NodeSnapshot[]): RuleCheckResult {
  const issues: RuleIssue[] = [];
  const byId = new Map(nodes.map((node) => [node.id, node]));
  let skippedContrastNodes = 0;

  for (const node of nodes) {
    if (node.type === "TEXT") {
      const role = classifyTextRole(node, byId);
      const minimumFontSize = minimumFontSizeForRole(role);
      if (minimumFontSize !== null && typeof node.fontSize === "number" && node.fontSize < minimumFontSize) {
        issues.push(
          createIssue(
            "font-size",
            node,
            fontSizeMessage(role),
            `${node.fontSize}px`,
            `不小于 ${minimumFontSize}px`,
            role === "auxiliary" ? "warning" : "error",
          ),
        );
      }

      if (role !== "decorative") {
        const foreground = node.fillKind === "solid" ? node.fills[0] : null;
        const background = nearestBackground(node, byId);
        if (!foreground || !background) {
          skippedContrastNodes += 1;
        } else {
          const ratio = contrastRatio(foreground, background);
          if (ratio < WCAG_AA_CONTRAST_RATIO) {
            issues.push(
              createIssue(
                "color-contrast",
                node,
                "文本与背景的颜色对比度未达到 WCAG AA 标准",
                `${ratio.toFixed(2)}:1`,
                `不低于 ${WCAG_AA_CONTRAST_RATIO}:1`,
              ),
            );
          }
        }
      }
    }

    if (isInteractiveCandidate(node) && (node.width < MIN_TARGET_SIZE || node.height < MIN_TARGET_SIZE)) {
      issues.push(
        createIssue(
          "target-size",
          node,
          "可点击区域尺寸小于最小要求",
          `${node.width} × ${node.height}px`,
          `宽和高均不小于 ${MIN_TARGET_SIZE}px`,
        ),
      );
    }
  }

  return { issues, skippedContrastNodes };
}
