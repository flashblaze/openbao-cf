import { APP_NAME } from "./name.ts";
import { login } from "./commands/login.ts";
import { run } from "./commands/run.ts";
import { pull } from "./commands/pull.ts";
import { push } from "./commands/push.ts";
import { proxy } from "./commands/proxy.ts";
import { envs } from "./commands/envs.ts";
import { migrate } from "./commands/migrate.ts";
import { defaultIo, type Io } from "./io.ts";

const HELP = `${APP_NAME} - project secrets stored in OpenBao

Usage:
  ${APP_NAME} login [--server <url>]               Sign in via Cloudflare Access and remember the server
  ${APP_NAME} run [--env <name>] -- <cmd...>       Run a command with the project's secrets in its environment
  ${APP_NAME} pull [--env <name>] [--force]        Write the secrets to .dev.vars (.dev.vars.<env> for other envs)
  ${APP_NAME} push [file] [--env <name>] [--yes]   Store .dev.vars (or file) as the project's secrets
  ${APP_NAME} envs                                 List the project's environments (* = default)
  ${APP_NAME} migrate [--yes]                      Move pre-environment secrets into the default environment
  ${APP_NAME} proxy [--login] -- <cmd...>          Run a command with BAO_ADDR pointing at a local authenticated proxy
`;

const commands: Record<string, (args: string[], io: Io) => Promise<number>> = { login, run, pull, push, envs, migrate, proxy };

export async function main(argv: string[], io: Io = defaultIo()): Promise<number> {
  const [name, ...rest] = argv;
  if (name === undefined || name === "--help" || name === "-h" || name === "help") {
    io.out(HELP);
    return name === undefined ? 2 : 0;
  }
  const cmd = Object.hasOwn(commands, name) ? commands[name] : undefined;
  if (!cmd) {
    io.err(`Unknown command: ${name}\n\n${HELP}`);
    return 2;
  }
  return cmd(rest, io);
}

if (import.meta.main) process.exit(await main(Bun.argv.slice(2)));
