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

function quote(key: string, v: string): string {
  // dotenv folds real \r to \n before parsing, so values with \r or \n need escapes in double quotes.
  if (!v.includes("'") && !v.includes("\n") && !v.includes("\r")) return `'${v}'`;
  // dotenv expands literal \n and \r inside double quotes, so those can't be double-quoted as-is.
  if (!v.includes('"') && !v.includes("\\n") && !v.includes("\\r")) {
    return `"${v.replaceAll("\n", "\\n").replaceAll("\r", "\\r")}"`;
  }
  if (!v.includes("`") && !v.includes("\r")) return `\`${v}\``;
  throw new UnrepresentableValueError(key);
}

export function serializeDevVars(vars: Record<string, string>): string {
  return Object.keys(vars)
    .sort()
    .map((k) => `${k}=${quote(k, vars[k]!)}\n`)
    .join("");
}
