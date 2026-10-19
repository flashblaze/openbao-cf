export type KeyDiff = { added: string[]; changed: string[]; removed: string[] };

export function diffKeys(current: Record<string, string>, next: Record<string, string>): KeyDiff {
  const has = (o: Record<string, string>, k: string) => Object.hasOwn(o, k);
  return {
    added: Object.keys(next).filter((k) => !has(current, k)).sort(),
    changed: Object.keys(next).filter((k) => has(current, k) && current[k] !== next[k]).sort(),
    removed: Object.keys(current).filter((k) => !has(next, k)).sort(),
  };
}

export const isEmptyDiff = (d: KeyDiff): boolean =>
  d.added.length === 0 && d.changed.length === 0 && d.removed.length === 0;

export const formatDiff = (d: KeyDiff): string =>
  [...d.added.map((k) => `+ ${k}`), ...d.changed.map((k) => `~ ${k}`), ...d.removed.map((k) => `- ${k}`)].join("\n");
