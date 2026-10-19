import { bindings, defineConfig, defineContainer, exports, triggers } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

const hostname = process.env.BAO_HOSTNAME;
if (!hostname) {
  throw new Error("BAO_HOSTNAME is required: set it to the public hostname for the OpenBao Worker, e.g. BAO_HOSTNAME=bao.example.com");
}

const container = defineContainer({
  name: "openbao",
  image: { dockerfile: "./container/Dockerfile" },
  instanceType: "lite",
  maxInstances: 1,
});

export default defineConfig({
  worker: {
    name: "openbao-cf",
    entrypoint,
    compatibilityDate: "2026-10-19",
    compatibilityFlags: ["nodejs_compat"],
    workersDev: false,
    previewUrls: false,
    observability: { enabled: true },
    domains: [hostname],
    exports: {
      OpenBao: exports.durableObject({ storage: "sqlite", container }),
    },
    env: {
      OPENBAO: bindings.durableObject({ worker: "openbao-cf", exportName: "OpenBao" }),
      BACKUPS: bindings.r2({ name: "openbao-cf-backups" }),
      BAO_SEAL_KEY: bindings.secret(),
      NEON_DATABASE_URL: bindings.secret(),
      ACCESS_TEAM_DOMAIN: bindings.secret(),
      ACCESS_AUD: bindings.secret(),
      OWNER_EMAIL: bindings.secret(),
    },
    triggers: [triggers.scheduled({ schedule: "17 3 * * *" })],
  },
  containers: [container],
});
