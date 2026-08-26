import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PROCESS_TERMINATION_GRACE_MS,
  runCommand,
  terminateProcess,
} from "./process-runner.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

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

  it("signals the POSIX process group when a child pid is available", async () => {
    vi.useFakeTimers();
    const childKill = vi.fn(() => true);
    const processKill = vi
      .spyOn(process, "kill")
      .mockImplementation(() => true);

    const cancelEscalation = terminateProcess({ pid: 42, kill: childKill });

    expect(processKill).toHaveBeenCalledWith(-42, "SIGTERM");
    expect(childKill).not.toHaveBeenCalled();
    cancelEscalation();
    await vi.advanceTimersByTimeAsync(PROCESS_TERMINATION_GRACE_MS);
    expect(processKill).toHaveBeenCalledTimes(1);
  });

  it("rejects before spawning when cancellation already won", async () => {
    await expect(
      runCommand(process.execPath, ["-e", "process.exit(0)"], {
        cwd: process.cwd(),
        signal: AbortSignal.abort(),
      }),
    ).rejects.toThrow("WORKER_JOB_CANCELLED");
  });

  it("keeps the tail of stderr (the actual error), not the banner, when truncating", async () => {
    const banner = "B".repeat(2_500);
    const script = `process.stderr.write(${JSON.stringify(banner)}); process.stderr.write("\\nREAL_ERROR: something broke\\n"); process.exit(1);`;
    await expect(
      runCommand(process.execPath, ["-e", script], {
        cwd: process.cwd(),
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("REAL_ERROR: something broke");
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
