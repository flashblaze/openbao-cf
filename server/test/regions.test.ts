import { expect, test } from "bun:test";
import { parseRegions } from "../src/regions";

test("parseRegions: unset or blank means no constraint", () => {
  expect(parseRegions(undefined)).toBeUndefined();
  expect(parseRegions("")).toBeUndefined();
  expect(parseRegions("  ")).toBeUndefined();
});

test("parseRegions: comma-separated, trimmed, upper-cased, de-duplicated", () => {
  expect(parseRegions("APAC")).toEqual(["APAC"]);
  expect(parseRegions(" apac , weur,APAC ")).toEqual(["APAC", "WEUR"]);
});

test("parseRegions: unknown regions fail with the allowed list", () => {
  expect(() => parseRegions("APAC,MARS")).toThrow("MARS");
  expect(() => parseRegions("APAC,MARS")).toThrow("ENAM");
});
