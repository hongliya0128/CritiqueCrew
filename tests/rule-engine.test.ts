import { describe, expect, it } from "vitest";
import type { NodeSnapshot, SolidColorSnapshot } from "../src/shared/messages";
import {
  MIN_AUXILIARY_FONT_SIZE,
  MIN_BODY_FONT_SIZE,
  MIN_FUNCTIONAL_FONT_SIZE,
  MIN_TARGET_SIZE,
  WCAG_AA_CONTRAST_RATIO,
  checkRules,
  contrastRatio,
} from "../src/shared/rule-engine";

const white: SolidColorSnapshot = { r: 1, g: 1, b: 1, a: 1 };
const black: SolidColorSnapshot = { r: 0, g: 0, b: 0, a: 1 };

function grayForContrastRatio(ratio: number): SolidColorSnapshot {
  const linear = 1.05 / ratio - 0.05;
  const channel =
    linear <= 0.0031308
      ? linear * 12.92
      : 1.055 * linear ** (1 / 2.4) - 0.055;
  return { r: channel, g: channel, b: channel, a: 1 };
}

function node(overrides: Partial<NodeSnapshot>): NodeSnapshot {
  const snapshot: NodeSnapshot = {
    id: "node-1",
    parentId: null,
    childIds: [],
    name: "Node",
    type: "FRAME",
    depth: 0,
    visible: true,
    locked: false,
    x: 0,
    y: 0,
    absoluteX: 0,
    absoluteY: 0,
    width: 100,
    height: 100,
    rotation: 0,
    opacity: 1,
    fills: [],
    fillKind: "none",
    hasPointerInteraction: false,
    fontSize: null,
    characters: null,
    cornerRadius: null,
    ...overrides,
  };
  if (overrides.fillKind === undefined) {
    snapshot.fillKind =
      snapshot.fills.length === 0
        ? "none"
        : snapshot.fills.length === 1
          ? "solid"
          : "complex";
  }
  return snapshot;
}

describe("rule engine", () => {
  it("calculates the canonical black-on-white WCAG contrast ratio", () => {
    expect(contrastRatio(black, white)).toBeCloseTo(21, 5);
    expect(WCAG_AA_CONTRAST_RATIO).toBe(4.5);
  });

  it("reports contrast, text-size, and target-size issues with node IDs", () => {
    const result = checkRules([
      node({ id: "card", name: "Card", fills: [white] }),
      node({
        id: "caption", parentId: "card", name: "Card description", type: "TEXT", fills: [{ r: 0.5, g: 0.5, b: 0.5, a: 1 }], fontSize: 12, characters: "Supporting body copy",
      }),
      node({ id: "save", name: "保存按钮", type: "INSTANCE", width: 40, height: 43 }),
    ]);

    expect(result.issues.map((issue) => issue.ruleId)).toEqual([
      "font-size",
      "color-contrast",
      "target-size",
    ]);
    expect(result.issues.map((issue) => issue.nodeId)).toEqual(["caption", "caption", "save"]);
    expect(result.issues[0].expected).toContain(`${MIN_BODY_FONT_SIZE}px`);
    expect(result.issues[2].expected).toContain(`${MIN_TARGET_SIZE}px`);
    expect(result.scoreItems).toEqual([
      expect.objectContaining({ ruleId: "color-contrast", checked: 1, passed: 0, failed: 1, score: 0 }),
      expect.objectContaining({ ruleId: "font-size", checked: 1, passed: 0, failed: 1, score: 0 }),
      expect.objectContaining({ ruleId: "target-size", checked: 1, passed: 0, failed: 1, score: 0 }),
    ]);
    expect(result.score).toBe(0);
  });

  it("skips contrast only when a text node has no determinable solid background", () => {
    const result = checkRules([
      node({ id: "text", name: "Text", type: "TEXT", fills: [black], fontSize: 16 }),
    ]);

    expect(result.issues).toHaveLength(0);
    expect(result.skippedContrastNodes).toBe(1);
  });

  it("checks an interactive root once and ignores its decorative icon", () => {
    const result = checkRules([
      node({
        id: "small-button",
        name: "确认预约按钮",
        type: "FRAME",
        width: 40,
        height: 40,
        childIds: ["arrow-icon"],
        fills: [{ r: 0.1, g: 0.45, b: 0.8, a: 1 }],
      }),
      node({
        id: "arrow-icon",
        parentId: "small-button",
        name: "小按钮图标",
        type: "TEXT",
        width: 18,
        height: 22,
        fontSize: 18,
        fills: [white],
      }),
    ]);

    expect(result.issues).toEqual([
      expect.objectContaining({ ruleId: "target-size", nodeId: "small-button" }),
    ]);
  });

  it("checks a nested button independently from its interactive input parent", () => {
    const result = checkRules([
      node({
        id: "symptom-input",
        name: "症状输入框",
        type: "FRAME",
        width: 342,
        height: 48,
        childIds: ["confirm-button"],
      }),
      node({
        id: "confirm-button",
        parentId: "symptom-input",
        name: "确认预约按钮（40x40-故意不合格）",
        type: "FRAME",
        width: 40,
        height: 40,
      }),
    ]);

    expect(result.issues).toEqual([
      expect.objectContaining({
        ruleId: "target-size",
        nodeId: "confirm-button",
        actual: "40 × 40px",
      }),
    ]);
  });

  it("recognizes a neutral frame with a pointer reaction as interactive", () => {
    const result = checkRules([
      node({
        id: "reaction-target",
        name: "Generic surface",
        type: "FRAME",
        width: 40,
        height: 40,
        hasPointerInteraction: true,
      }),
    ]);

    expect(result.issues).toEqual([
      expect.objectContaining({
        ruleId: "target-size",
        nodeId: "reaction-target",
      }),
    ]);
  });

  it("skips contrast at the nearest complex background instead of using an outer fill", () => {
    const result = checkRules([
      node({ id: "screen", name: "Screen", fills: [white] }),
      node({
        id: "gradient-card",
        parentId: "screen",
        name: "Gradient card",
        fillKind: "complex",
      }),
      node({
        id: "card-copy",
        parentId: "gradient-card",
        name: "Card copy",
        type: "TEXT",
        fontSize: 16,
        fills: [black],
      }),
    ]);

    expect(result.issues).toHaveLength(0);
    expect(result.skippedContrastNodes).toBe(1);
  });

  it("ignores a decorative avatar initial rather than treating it as body text", () => {
    const result = checkRules([
      node({ id: "avatar", name: "个人头像", fills: [{ r: 0.25, g: 0.53, b: 0.89, a: 1 }] }),
      node({
        id: "avatar-initial",
        parentId: "avatar",
        name: "头像首字母（装饰性）",
        type: "TEXT",
        fontSize: 18,
        fills: [white],
      }),
    ]);

    expect(result.issues).toHaveLength(0);
    expect(result.skippedContrastNodes).toBe(0);
  });

  it("applies role-specific minimum sizes to body, functional, auxiliary, and metric text", () => {
    const result = checkRules([
      node({
        id: "screen",
        name: "Home screen",
        fills: [white],
        childIds: ["status-bar", "page-title", "shortcut", "body-copy", "score-value", "bottom-nav"],
      }),
      node({ id: "status-bar", parentId: "screen", name: "系统状态栏", childIds: ["system-time"] }),
      node({
        id: "system-time",
        parentId: "status-bar",
        name: "系统时间",
        type: "TEXT",
        fontSize: 10,
        characters: "9:41",
        fills: [black],
      }),
      node({
        id: "page-title",
        parentId: "screen",
        name: "问候标题",
        type: "TEXT",
        fontSize: 12,
        characters: "早上好，小林",
        fills: [black],
      }),
      node({ id: "shortcut", parentId: "screen", name: "症状自测按钮", childIds: ["shortcut-label"] }),
      node({
        id: "shortcut-label",
        parentId: "shortcut",
        name: "症状自测文本",
        type: "TEXT",
        fontSize: 12,
        characters: "症状自测",
        fills: [black],
      }),
      node({
        id: "body-copy",
        parentId: "screen",
        name: "健康评分说明",
        type: "TEXT",
        fontSize: 12,
        characters: "比昨天提升 8%，继续保持！",
        fills: [black],
      }),
      node({
        id: "score-value",
        parentId: "screen",
        name: "健康评分数值",
        type: "TEXT",
        fontSize: 12,
        characters: "86",
        fills: [black],
      }),
      node({ id: "bottom-nav", parentId: "screen", name: "底部导航", childIds: ["home-label"] }),
      node({
        id: "home-label",
        parentId: "bottom-nav",
        name: "首页导航文本",
        type: "TEXT",
        fontSize: 11,
        characters: "首页",
        fills: [black],
      }),
    ]);

    expect(result.issues.filter((issue) => issue.ruleId === "font-size")).toEqual([
      expect.objectContaining({
        nodeId: "system-time",
        severity: "warning",
        expected: `不小于 ${MIN_AUXILIARY_FONT_SIZE}px`,
      }),
      expect.objectContaining({
        nodeId: "page-title",
        severity: "error",
        expected: `不小于 ${MIN_BODY_FONT_SIZE}px`,
      }),
      expect.objectContaining({
        nodeId: "body-copy",
        severity: "error",
        expected: `不小于 ${MIN_BODY_FONT_SIZE}px`,
      }),
      expect.objectContaining({
        nodeId: "score-value",
        severity: "error",
        expected: `不小于 ${MIN_BODY_FONT_SIZE}px`,
      }),
      expect.objectContaining({
        nodeId: "home-label",
        severity: "error",
        expected: `不小于 ${MIN_FUNCTIONAL_FONT_SIZE}px`,
      }),
    ]);
  });

  it("accepts text exactly at each role threshold and ignores decorative glyph font size", () => {
    const result = checkRules([
      node({ id: "screen", name: "Screen", fills: [white] }),
      node({
        id: "body",
        parentId: "screen",
        name: "正文说明",
        type: "TEXT",
        fontSize: MIN_BODY_FONT_SIZE,
        characters: "正文",
        fills: [black],
      }),
      node({
        id: "nav",
        parentId: "screen",
        name: "首页导航文本",
        type: "TEXT",
        fontSize: MIN_FUNCTIONAL_FONT_SIZE,
        characters: "首页",
        fills: [black],
      }),
      node({
        id: "time",
        parentId: "screen",
        name: "系统时间",
        type: "TEXT",
        fontSize: MIN_AUXILIARY_FONT_SIZE,
        characters: "9:41",
        fills: [black],
      }),
      node({
        id: "icon",
        parentId: "screen",
        name: "导航图标",
        type: "TEXT",
        fontSize: 8,
        characters: "⌂",
        fills: [black],
      }),
    ]);

    expect(result.issues.filter((issue) => issue.ruleId === "font-size")).toHaveLength(0);
  });

  it("handles contrast, font-size, and target-size boundaries exactly", () => {
    const exactContrast = grayForContrastRatio(WCAG_AA_CONTRAST_RATIO);
    const belowContrast = grayForContrastRatio(WCAG_AA_CONTRAST_RATIO - 0.01);
    expect(contrastRatio(exactContrast, white)).toBeCloseTo(WCAG_AA_CONTRAST_RATIO, 10);

    const result = checkRules([
      node({ id: "screen", name: "Screen", fills: [white] }),
      node({
        id: "contrast-pass",
        parentId: "screen",
        name: "Contrast pass",
        type: "TEXT",
        fontSize: 14,
        fills: [exactContrast],
      }),
      node({
        id: "contrast-fail",
        parentId: "screen",
        name: "Contrast fail",
        type: "TEXT",
        fontSize: 14,
        fills: [belowContrast],
      }),
      node({
        id: "font-pass",
        parentId: "screen",
        name: "Body pass",
        type: "TEXT",
        fontSize: 14,
        fills: [black],
      }),
      node({
        id: "font-fail",
        parentId: "screen",
        name: "Body fail",
        type: "TEXT",
        fontSize: 13.99,
        fills: [black],
      }),
      node({
        id: "target-pass",
        name: "Button pass",
        width: 44,
        height: 44,
      }),
      node({
        id: "target-width-fail",
        name: "Button width fail",
        width: 43,
        height: 44,
      }),
      node({
        id: "target-height-fail",
        name: "Button height fail",
        width: 44,
        height: 43,
      }),
    ]);

    expect(result.issues.filter((issue) => issue.ruleId === "color-contrast")).toEqual([
      expect.objectContaining({ nodeId: "contrast-fail" }),
    ]);
    expect(result.issues.filter((issue) => issue.ruleId === "font-size")).toEqual([
      expect.objectContaining({ nodeId: "font-fail" }),
    ]);
    expect(result.issues.filter((issue) => issue.ruleId === "target-size")).toEqual([
      expect.objectContaining({ nodeId: "target-width-fail" }),
      expect.objectContaining({ nodeId: "target-height-fail" }),
    ]);
  });
});
