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
export const PROCESS_TERMINATION_GRACE_MS = 3_000;

type KillableProcess = Readonly<{
  pid?: number | undefined;
  kill(signal?: NodeJS.Signals): boolean;
}>;

export const terminateProcess = (child: KillableProcess): (() => void) => {
  const signal = (value: NodeJS.Signals): void => {
    if (process.platform !== "win32" && child.pid !== undefined)
      try {
        process.kill(-child.pid, value);
        return;
      } catch {
        child.kill(value);
        return;
      }
    child.kill(value);
  };
  signal("SIGTERM");
  const escalation = setTimeout(
    () => signal("SIGKILL"),
    PROCESS_TERMINATION_GRACE_MS,
  );
  escalation.unref();
  return () => clearTimeout(escalation);
};

export const runCommand: CommandRunner = async (command, args, options) => {
  if (options.signal.aborted) throw new Error("WORKER_JOB_CANCELLED");
  const child = spawn(command, [...args], {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout = (stdout + chunk.toString()).slice(-MAX_DIAGNOSTIC_BYTES);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-MAX_DIAGNOSTIC_BYTES);
  });
  let stoppedFor: "WORKER_JOB_CANCELLED" | "WORKER_PROCESS_TIMEOUT" | null =
    null;
  let clearEscalation = (): void => {};
  const stop = (reason: NonNullable<typeof stoppedFor>): void => {
    if (stoppedFor !== null) return;
    stoppedFor = reason;
    clearEscalation = terminateProcess(child);
  };
  const abort = (): void => stop("WORKER_JOB_CANCELLED");
  options.signal.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(
    () => stop("WORKER_PROCESS_TIMEOUT"),
    options.timeoutMs ?? 1_800_000,
  );
  try {
    const result = await new Promise<Readonly<{ code: number | null }>>(
      (resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) => resolve({ code }));
      },
    );
    if (stoppedFor !== null) throw new Error(stoppedFor);
    if (result.code !== 0)
      throw new Error(
        `WORKER_PROCESS_FAILED:${command}:${stderr.replaceAll(options.cwd, "[workspace]").trim().slice(-2_000)}`,
      );
    return { stdout, stderr };
  } finally {
    clearTimeout(timeout);
    clearEscalation();
    options.signal.removeEventListener("abort", abort);
  }
};
