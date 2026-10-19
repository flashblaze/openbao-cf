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
