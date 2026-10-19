import { expect, test } from "bun:test";
import { noSecretsMessage, resolveEnv, takeEnvFlag } from "../src/context.ts";

const p = { name: "p", root: "/r", defaultEnv: "dev" };

test("takeEnvFlag parses both forms and keeps other args", () => {
  expect(takeEnvFlag(["--env", "staging", "--force"])).toEqual({ env: "staging", rest: ["--force"] });
  expect(takeEnvFlag(["--force", "--env=prod"])).toEqual({ env: "prod", rest: ["--force"] });
  expect(takeEnvFlag(["--yes"])).toEqual({ env: undefined, rest: ["--yes"] });
});
test("takeEnvFlag errors", () => {
  expect(() => takeEnvFlag(["--env"])).toThrow("--env needs a value");
  expect(() => takeEnvFlag(["--env="])).toThrow("--env needs a value");
  expect(() => takeEnvFlag(["--env", "Bad!"])).toThrow("Invalid environment name: Bad!");
});
test("resolveEnv: flag wins, then the project's default", () => {
  const local = { ...p, defaultEnv: "local" };
  expect(resolveEnv("staging", local)).toBe("staging");
  expect(resolveEnv(undefined, local)).toBe("local");
});
test("noSecretsMessage omits --env for the default env", () => {
  expect(noSecretsMessage(p, "dev")).toBe("No secrets stored for project p (dev). Run `secrets push` first.");
  expect(noSecretsMessage(p, "qa")).toBe("No secrets stored for project p (qa). Run `secrets push --env qa` first.");
});
