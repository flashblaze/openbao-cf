import { expect, test } from "bun:test";
import { diffKeys, formatDiff, isEmptyDiff } from "../src/diff.ts";

test("diffKeys", () => expect(diffKeys({ A: "1", B: "2", C: "3" }, { A: "1", B: "9", D: "4" }))
  .toEqual({ added: ["D"], changed: ["B"], removed: ["C"] }));
test("diffKeys sorts each list", () => expect(diffKeys({}, { Z: "1", A: "1" }).added).toEqual(["A", "Z"]));
test("isEmptyDiff", () => {
  expect(isEmptyDiff(diffKeys({ A: "1" }, { A: "1" }))).toBe(true);
  expect(isEmptyDiff(diffKeys({ A: "1" }, { A: "2" }))).toBe(false);
});
test("formatDiff names only", () => expect(formatDiff({ added: ["D"], changed: ["B"], removed: ["C"] }))
  .toBe("+ D\n~ B\n- C"));
