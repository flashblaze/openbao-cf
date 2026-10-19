import { expect, test } from "bun:test";
import { parseDevVars, serializeDevVars, UnrepresentableValueError } from "../src/dotenv.ts";

const awkward = { A: "plain", B: "with space", C: `it's`, D: `say "hi"`, E: "a=b=c", F: "#not a comment",
  G: "line1\nline2", H: "", I: "naïve ✓", J: `both ' and "`, K: "back\\slash", L: "literal \\n here", M: "cr\r\nlf\rend" };

test("round-trips awkward values", () => expect(parseDevVars(serializeDevVars(awkward))).toEqual(awkward));
test("serializes sorted with a trailing newline", () =>
  expect(serializeDevVars({ B: "2", A: "1" })).toBe("A='1'\nB='2'\n"));
test("parses a typical file", () => expect(parseDevVars(
  "# comment\nexport API_KEY=abc\nURL=\"https://x?y=1\" # trailing\nSINGLE='raw $x'\n")).toEqual(
  { API_KEY: "abc", URL: "https://x?y=1", SINGLE: "raw $x" }));
test("throws when a value cannot be quoted", () => expect(() =>
  serializeDevVars({ X: "' \" ` \n" })).toThrow(UnrepresentableValueError));

test("values ending in a backslash round-trip", () => {
  expect(parseDevVars(serializeDevVars({ A: "x\\", B: "y" }))).toEqual({ A: "x\\", B: "y" });
  expect(parseDevVars(serializeDevVars({ A: "x\\", B: "#y" }))).toEqual({ A: "x\\", B: "#y" });
  expect(parseDevVars(serializeDevVars({ K0: "\\", K1: "#$" }))).toEqual({ K0: "\\", K1: "#$" });
  expect(parseDevVars(serializeDevVars({ A: "#x\\", B: "'q" }))).toEqual({ A: "#x\\", B: "'q" });
});
test("throws instead of returning output that parses differently", () => {
  // '#', all three quote characters and a trailing backslash: no form can carry it.
  expect(() => serializeDevVars({ A: "#'\"`\\", B: "y" })).toThrow(UnrepresentableValueError);
});
test("fuzz: serialize either throws or round-trips exactly", () => {
  let seed = 12345;
  const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), seed % n);
  const alphabet = ["\\", "'", '"', "`", "#", "\n", "\r", " ", "=", "n", "a", "$"];
  const value = () => Array.from({ length: rnd(5) }, () => alphabet[rnd(alphabet.length)]).join("");
  let ok = 0;
  for (let i = 0; i < 3000; i++) {
    const vars: Record<string, string> = {};
    for (let k = 0, n = 1 + rnd(4); k < n; k++) vars[`K${k}`] = value();
    try {
      expect(parseDevVars(serializeDevVars(vars))).toEqual(vars);
      ok++;
    } catch (e) {
      if (!(e instanceof UnrepresentableValueError)) throw e;
    }
  }
  expect(ok).toBeGreaterThan(2000);
});
