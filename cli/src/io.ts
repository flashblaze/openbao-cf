export type Runner = (cmd: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

export type Io = {
  cwd: string;
  env: Record<string, string | undefined>;
  out(s: string): void;
  err(s: string): void;
  isTTY: boolean;
  confirm(q: string): Promise<boolean>;
  fetch: typeof fetch;
  run: Runner;
  runInherit(cmd: string[]): Promise<number>;
};

const run: Runner = async (cmd) => {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
};

async function confirm(q: string): Promise<boolean> {
  process.stderr.write(`${q} [y/N] `);
  const answer = await new Promise<string>((resolve) => {
    const onData = (chunk: Buffer | string) => {
      process.stdin.off("data", onData);
      process.stdin.pause();
      resolve(String(chunk));
    };
    process.stdin.resume();
    process.stdin.once("end", () => resolve(""));
    process.stdin.on("data", onData);
  });
  return /^\s*y(es)?\s*$/i.test(answer);
}

export function defaultIo(): Io {
  return {
    cwd: process.cwd(),
    env: process.env,
    out: (s) => void process.stdout.write(s),
    err: (s) => void process.stderr.write(s),
    isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    confirm,
    fetch: globalThis.fetch,
    run,
    runInherit: async (cmd) => {
      const proc = Bun.spawn(cmd, { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
      return proc.exited;
    },
  };
}
