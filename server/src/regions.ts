// Cloudflare Containers placement regions (developers.cloudflare.com/containers/concepts/placement/).
export const CONTAINER_REGIONS = ["ENAM", "WNAM", "EEUR", "WEUR", "APAC", "SAM", "ME", "OC", "AFR"] as const;
export type ContainerRegion = (typeof CONTAINER_REGIONS)[number];

/**
 * Parses BAO_REGIONS ("APAC" or "ENAM,WNAM"). Unset or blank means no constraint, so Cloudflare
 * places the container near the first request. Pin it close to you and your database.
 */
export function parseRegions(value: string | undefined): ContainerRegion[] | undefined {
  const parts = (value ?? "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  if (parts.length === 0) return undefined;
  const unknown = parts.filter((p) => !(CONTAINER_REGIONS as readonly string[]).includes(p));
  if (unknown.length > 0) {
    throw new Error(`BAO_REGIONS has unknown region(s) ${unknown.join(", ")}; use one or more of ${CONTAINER_REGIONS.join(", ")}`);
  }
  return [...new Set(parts)] as ContainerRegion[];
}
