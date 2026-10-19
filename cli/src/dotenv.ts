import { parse } from "dotenv";

export class UnrepresentableValueError extends Error {
  constructor(readonly key: string) {
    super(`Value of ${key} cannot be written to .dev.vars`);
    this.name = "UnrepresentableValueError";
  }
}

export function parseDevVars(text: string): Record<string, string> {
  return parse(text);
}

// Candidate encodings of one value, most preferred first. Whether a candidate really parses back
// to the value depends on the lines after it (dotenv's quoted-value regex runs across newlines and
// treats a backslash before the quote as an escape), so serializeDevVars verifies each choice.
function candidates(v: string): string[] {
  const out: string[] = [];
  // Unquoted: dotenv takes [^#\r\n]+, trims it, and strips a matching surrounding quote pair.
  const unquoted = v !== "" && !/[#\r\n]/.test(v) && v.trim() === v && !/^['"`]/.test(v);
  const hasCrLf = v.includes("\n") || v.includes("\r");
  const single = !v.includes("'") && !hasCrLf ? [`'${v}'`] : [];
  const double =
    !v.includes('"') && !v.includes("\\n") && !v.includes("\\r")
      ? [`"${v.replaceAll("\n", "\\n").replaceAll("\r", "\\r")}"`]
      : [];
  // Real \r is folded to \n by dotenv before parsing, so only the double-quoted escape carries it.
  const backtick = !v.includes("`") && !v.includes("\r") ? [`\`${v}\``] : [];
  // A trailing backslash escapes the closing quote, so prefer the unquoted form for those values.
  if (unquoted && v.endsWith("\\")) out.push(v);
  out.push(...single, ...double, ...backtick);
  if (unquoted && !v.endsWith("\\")) out.push(v);
  return out;
}

export function serializeDevVars(vars: Record<string, string>): string {
  // Build from the last line up: a line can only be disturbed by the lines after it, so each choice
  // is checked against the whole text built so far.
  let text = "";
  for (const key of Object.keys(vars).sort().reverse()) {
    const line = candidates(vars[key]!)
      .map((c) => `${key}=${c}\n`)
      .find((l) => {
        const parsed = parseDevVars(l + text);
        return parsed[key] === vars[key] && Object.keys(parsed).every((k) => parsed[k] === vars[k]);
      });
    if (line === undefined) throw new UnrepresentableValueError(key);
    text = line + text;
  }
  return text;
}
