import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PROCESS_TERMINATION_GRACE_MS,
  runCommand,
  terminateProcess,
} from "./process-runner.js";

afterEach(() => vi.useRealTimers());

describe("process termination", () => {
  it("escalates SIGTERM to SIGKILL after the bounded grace period", async () => {
    vi.useFakeTimers();
    const signals: NodeJS.Signals[] = [];
    const cancelEscalation = terminateProcess({
      kill: (signal: NodeJS.Signals = "SIGTERM") => {
        signals.push(signal);
        return true;
      },
    });

    expect(signals).toEqual(["SIGTERM"]);
    await vi.advanceTimersByTimeAsync(PROCESS_TERMINATION_GRACE_MS);
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    cancelEscalation();
  });

  it("rejects before spawning when cancellation already won", async () => {
    await expect(
      runCommand(process.execPath, ["-e", "process.exit(0)"], {
        cwd: process.cwd(),
        signal: AbortSignal.abort(),
      }),
    ).rejects.toThrow("WORKER_JOB_CANCELLED");
  });

  it("reports the command deadline after terminating the child", async () => {
    await expect(
      runCommand(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], {
        cwd: process.cwd(),
        signal: new AbortController().signal,
        timeoutMs: 10,
      }),
    ).rejects.toThrow("WORKER_PROCESS_TIMEOUT");
  });
});
