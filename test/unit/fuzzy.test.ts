import { describe, expect, it } from "vitest";
import { editDistance, normaliseAnswer, suggestMark } from "../../src/shared/fuzzy";

describe("normaliseAnswer", () => {
  it.each([
    ["  The Beatles! ", "beatles"],
    ["Beyoncé", "beyonce"],
    ["Rock & Roll", "rock and roll"],
    ["O'Brien", "obrien"],
    ["A Tribe Called Quest", "tribe called quest"],
    ["A", "a"],
  ])("%j becomes %j", (input, expected) => {
    expect(normaliseAnswer(input)).toBe(expected);
  });
});

describe("editDistance", () => {
  it("counts insertions, deletions and substitutions", () => {
    expect(editDistance("kitten", "sitting")).toBe(3);
    expect(editDistance("", "abc")).toBe(3);
    expect(editDistance("same", "same")).toBe(0);
  });
});

describe("suggestMark", () => {
  it("treats formatting differences as exact", () => {
    expect(suggestMark("the pacific", ["Pacific"]).kind).toBe("exact");
    expect(suggestMark("New castle", ["Newcastle"]).kind).toBe("exact");
  });

  it("flags small typos on longer answers as close", () => {
    expect(suggestMark("Shakespere", ["William Shakespeare", "Shakespeare"])).toEqual({ kind: "close", closestTo: "Shakespeare" });
    expect(suggestMark("Cardif", ["Cardiff"]).kind).toBe("close");
  });

  it("accepts a surname as close for a full name", () => {
    expect(suggestMark("Austen", ["Jane Austen"]).kind).toBe("close");
  });

  it("gives short answers no slack", () => {
    expect(suggestMark("Ag", ["Au"]).kind).toBe("none");
    expect(suggestMark("cat", ["car"]).kind).toBe("none");
  });

  it("does not match unrelated or empty answers", () => {
    expect(suggestMark("London", ["Paris"]).kind).toBe("none");
    expect(suggestMark("   ", ["Paris"])).toEqual({ kind: "none", closestTo: null });
  });
});
