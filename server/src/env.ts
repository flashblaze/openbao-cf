import type { OpenBao } from "./container";

export interface Env {
  OPENBAO: DurableObjectNamespace<OpenBao>;
  BACKUPS: R2Bucket;
  BAO_SEAL_KEY: string;
  NEON_DATABASE_URL: string;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  OWNER_EMAIL: string;
}
