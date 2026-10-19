import { ROLE } from "./name.ts";

const ACCESS_MESSAGE = "Access session missing or expired. Run `secrets login`.";

export class AccessDeniedError extends Error {
  constructor() {
    super(ACCESS_MESSAGE);
    this.name = "AccessDeniedError";
  }
}

export class BaoError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "BaoError";
  }
}

export type BaoClient = {
  token: string;
  readSecret(project: string, env: string): Promise<Record<string, string> | null>;
  writeSecret(project: string, env: string, data: Record<string, string>): Promise<void>;
};

type Opts = { fetch: typeof fetch; retries?: number; retryDelayMs?: number };

async function json(res: Response): Promise<any> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

export async function connect(server: string, accessJwt: string, opts: Opts): Promise<BaoClient> {
  const retries = opts.retries ?? 3;
  const delay = opts.retryDelayMs ?? 2000;

  // Single choke point: headers, redirects, 503 retries and error mapping.
  async function request(
    method: string,
    path: string,
    body: unknown,
    token: string | undefined,
    allow404 = false,
  ): Promise<any | null> {
    const headers: Record<string, string> = { "cf-access-token": accessJwt };
    if (token) headers["X-Vault-Token"] = token;
    if (body !== undefined) headers["content-type"] = "application/json";

    for (let attempt = 0; ; attempt++) {
      const res = await opts.fetch(`${server}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "manual",
      });
      if (res.status >= 300 && res.status < 400) {
        await res.body?.cancel();
        throw new AccessDeniedError();
      }
      if (res.status === 503) {
        await res.body?.cancel();
        if (attempt >= retries) throw new BaoError(503, "OpenBao is still starting; try again");
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      const parsed = await json(res);
      if (res.status === 403 && parsed?.error === "access denied") throw new AccessDeniedError();
      if (allow404 && res.status === 404) return null;
      if (!res.ok) {
        const first = Array.isArray(parsed?.errors) ? parsed.errors[0] : undefined;
        throw new BaoError(res.status, typeof first === "string" && first ? first : `HTTP ${res.status}`);
      }
      return parsed;
    }
  }

  const login = await request("POST", "/v1/auth/jwt/login", { role: ROLE, jwt: accessJwt }, undefined);
  const token = login?.auth?.client_token;
  if (typeof token !== "string" || !token) throw new BaoError(200, "OpenBao login returned no token");

  const secretPath = (project: string, env: string) =>
    `/v1/secret/data/${encodeURIComponent(project)}/${encodeURIComponent(env)}`;
  return {
    token,
    async readSecret(project, env) {
      const body = await request("GET", secretPath(project, env), undefined, token, true);
      return body === null ? null : (body?.data?.data ?? null);
    },
    async writeSecret(project, env, data) {
      await request("POST", secretPath(project, env), { data }, token);
    },
  };
}
