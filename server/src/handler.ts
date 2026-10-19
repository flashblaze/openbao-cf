import type { AccessResult } from "./access";

export type HandlerDeps = {
  verify(token: string | null): Promise<AccessResult>;
  forward(request: Request): Promise<Response>;
};

export async function handleRequest(request: Request, deps: HandlerDeps): Promise<Response> {
  const result = await deps.verify(request.headers.get("cf-access-jwt-assertion"));
  if (!result.ok) {
    console.warn(`access denied: ${result.reason}`);
    return Response.json({ error: "access denied" }, { status: 403 });
  }
  return deps.forward(request);
}
