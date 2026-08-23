import { spawn } from "node:child_process";

export type CommandResult = Readonly<{ stdout: string; stderr: string }>;
export type CommandOptions = Readonly<{
  cwd: string;
  signal: AbortSignal;
  env?: Readonly<NodeJS.ProcessEnv>;
  timeoutMs?: number;
}>;
export type CommandRunner = (
  command: string,
  args: readonly string[],
  options: CommandOptions,
) => Promise<CommandResult>;

const MAX_DIAGNOSTIC_BYTES = 64 * 1024;

export const runCommand: CommandRunner = async (command, args, options) => {
  if (options.signal.aborted) throw new Error("WORKER_JOB_CANCELLED");
  const child = spawn(command, [...args], {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout = (stdout + chunk.toString()).slice(-MAX_DIAGNOSTIC_BYTES);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-MAX_DIAGNOSTIC_BYTES);
  });
  const stop = (): void => {
    child.kill("SIGTERM");
  };
  options.signal.addEventListener("abort", stop, { once: true });
  const timeout = setTimeout(stop, options.timeoutMs ?? 1_800_000);
  try {
    const result = await new Promise<Readonly<{ code: number | null }>>(
      (resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) => resolve({ code }));
      },
    );
    if (options.signal.aborted) throw new Error("WORKER_JOB_CANCELLED");
    if (result.code !== 0)
      throw new Error(
        `WORKER_PROCESS_FAILED:${command}:${stderr.replaceAll(options.cwd, "[workspace]").trim().slice(0, 2_000)}`,
      );
    return { stdout, stderr };
  } finally {
    clearTimeout(timeout);
    options.signal.removeEventListener("abort", stop);
  }
};
