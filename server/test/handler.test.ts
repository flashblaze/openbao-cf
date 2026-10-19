import { expect, test } from "bun:test";
import { handleRequest } from "../src/handler";

test("rejects without forwarding", async () => {
  let forwarded = false;
  const res = await handleRequest(new Request("https://bao.test/v1/sys/health"), {
    verify: async () => ({ ok: false, reason: "missing token" }),
    forward: async () => {
      forwarded = true;
      return new Response();
    },
  });
  expect(res.status).toBe(403);
  expect(await res.json()).toEqual({ error: "access denied" });
  expect(forwarded).toBe(false);
});

test("passes the token to verify and forwards the same request", async () => {
  const req = new Request("https://bao.test/v1/secret/data/demo", { headers: { "cf-access-jwt-assertion": "tok" } });
  let seen = null as string | null;
  let got = null as Request | null;
  const res = await handleRequest(req, {
    verify: async (t) => {
      seen = t;
      return { ok: true, email: "owner@example.com" };
    },
    forward: async (r) => {
      got = r;
      return new Response("ok");
    },
  });
  expect(seen).toBe("tok");
  expect(got).toBe(req);
  expect(await res.text()).toBe("ok");
});
