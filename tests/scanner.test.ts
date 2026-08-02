import { describe, expect, it } from "vitest";
import {
  MAX_TEXT_LENGTH,
  MAX_VISIBLE_NODES,
  isSupportedSelectionRoot,
  scanNodeTree,
} from "../src/main/scanner";

function fakeNode(
  id: string,
  type: SceneNode["type"],
  children: SceneNode[] = [],
  overrides: Record<string, unknown> = {},
): SceneNode {
  return {
    id,
    type,
    name: id,
    visible: true,
    locked: false,
    x: 10,
    y: 20,
    width: 100,
    height: 44,
    rotation: 0,
    opacity: 1,
    absoluteBoundingBox: { x: 10, y: 20, width: 100, height: 44 },
    fills: [],
    children,
    ...overrides,
  } as unknown as SceneNode;
}

describe("scanNodeTree", () => {
  it("allows a group to be used as the selected scan root", () => {
    expect(isSupportedSelectionRoot(fakeNode("group-root", "GROUP"))).toBe(true);
  });

  it("flattens visible nodes and preserves hierarchy", () => {
    const hidden = fakeNode("hidden", "RECTANGLE", [], { visible: false });
    const child = fakeNode("child", "TEXT", [], { fontSize: 14, characters: "Hello" });
    const root = fakeNode("root", "FRAME", [child, hidden]);

    const result = scanNodeTree([root]);

    expect(result.truncated).toBe(false);
    expect(result.nodes.map((node) => node.id)).toEqual(["root", "child"]);
    expect(result.nodes[1].parentId).toBe("root");
    expect(result.nodes[1].depth).toBe(1);
    expect(result.nodes[1].fontSize).toBe(14);
  });

  it("limits node count and text length", () => {
    const longText = "a".repeat(MAX_TEXT_LENGTH + 50);
    const children = [
      fakeNode("text", "TEXT", [], { fontSize: 16, characters: longText }),
      fakeNode("extra", "RECTANGLE"),
    ];

    const result = scanNodeTree([fakeNode("root", "FRAME", children)], 2);

    expect(result.truncated).toBe(true);
    expect(result.nodes).toHaveLength(2);
    expect(result.nodes[1].characters).toHaveLength(MAX_TEXT_LENGTH);
  });

  it("uses a 1000-node default page limit", () => {
    const children = Array.from({ length: MAX_VISIBLE_NODES }, (_, index) =>
      fakeNode(`child-${index}`, "RECTANGLE"),
    );

    const result = scanNodeTree([fakeNode("root", "FRAME", children)]);

    expect(MAX_VISIBLE_NODES).toBe(1000);
    expect(result.nodes).toHaveLength(1000);
    expect(result.truncated).toBe(true);
  });

  it("captures pointer reactions and marks non-solid fills as complex", () => {
    const interactive = fakeNode("interactive", "FRAME", [], {
      reactions: [
        {
          trigger: { type: "ON_CLICK" },
          actions: [{ type: "BACK" }],
        },
      ],
    });
    const gradient = fakeNode("gradient", "FRAME", [], {
      fills: [
        {
          type: "GRADIENT_LINEAR",
          visible: true,
          gradientTransform: [
            [1, 0, 0],
            [0, 1, 0],
          ],
          gradientStops: [],
        },
      ],
    });

    const result = scanNodeTree([interactive, gradient]);

    expect(result.nodes[0]).toMatchObject({
      hasPointerInteraction: true,
      fillKind: "none",
    });
    expect(result.nodes[1]).toMatchObject({
      hasPointerInteraction: false,
      fillKind: "complex",
      fills: [],
    });
  });
});
