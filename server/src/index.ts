import { getContainer } from "@cloudflare/containers";
import { makeVerifier } from "./access";
import { runBackup } from "./backup";
import { queryKvRows } from "./db";
import type { Env } from "./env";
import { handleRequest } from "./handler";

export { OpenBao } from "./container";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, {
      verify: makeVerifier({
        teamDomain: env.ACCESS_TEAM_DOMAIN,
        aud: env.ACCESS_AUD,
        ownerEmail: env.OWNER_EMAIL,
      }),
      forward: (r) => getContainer(env.OPENBAO, "primary").fetch(r),
    });
  },

  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    const result = await runBackup({
      query: () => queryKvRows(env.NEON_DATABASE_URL),
      bucket: env.BACKUPS,
      now: new Date(controller.scheduledTime),
    });
    console.log(JSON.stringify(result));
  },
} satisfies ExportedHandler<Env>;
