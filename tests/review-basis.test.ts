import { describe, expect, it } from "vitest";
import {
  getReviewBasesForRole,
  REVIEW_BASIS_IDS,
  REVIEW_BASIS_LIBRARY,
} from "../src/shared/review-basis";

describe("review basis library", () => {
  it("keeps the reviewed ID catalogue and source library in sync", () => {
    expect(new Set(REVIEW_BASIS_IDS).size).toBe(REVIEW_BASIS_IDS.length);
    expect(REVIEW_BASIS_LIBRARY.map((basis) => basis.id)).toEqual([...REVIEW_BASIS_IDS]);
    expect(REVIEW_BASIS_LIBRARY.every((basis) => basis.url.startsWith("https://"))).toBe(true);
  });

  it("routes specialist sources only to the roles that can use them", () => {
    const visualIds = getReviewBasesForRole("visual").map((basis) => basis.id);
    const accessibilityIds = getReviewBasesForRole("accessibility").map((basis) => basis.id);
    const interactionIds = getReviewBasesForRole("interaction").map((basis) => basis.id);

    expect(visualIds).toContain("NNG-VISUAL-DESIGN");
    expect(visualIds).not.toContain("W3C-COGA-CONTENT-USABLE");
    expect(accessibilityIds).toContain("W3C-COGA-CONTENT-USABLE");
    expect(accessibilityIds).toContain("MICROSOFT-INCLUSIVE-DESIGN");
    expect(interactionIds).toContain("APPLE-FEEDBACK");
    expect(interactionIds).toContain("WCAG22-3.3.4");
  });

  it("marks supplemental cognitive guidance as guidance rather than a WCAG standard", () => {
    const cogaSources = REVIEW_BASIS_LIBRARY.filter((basis) => basis.id.startsWith("W3C-COGA"));
    expect(cogaSources).toHaveLength(2);
    expect(cogaSources.every((basis) => basis.kind === "guideline")).toBe(true);
  });
});
