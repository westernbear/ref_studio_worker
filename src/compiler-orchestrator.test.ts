import { EventEmitter } from "node:events";
import { unlink } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  CompilerOrchestrator,
  type CompileRequest,
  type ProcessFactory,
  type Spawned,
} from "./compiler-orchestrator.js";

const bundle = {
  measurements: [
    {
      name: "ocr.bounds",
      value: "100",
      units: "px",
      confidence: 1,
      source: "fixture",
    },
  ],
};
function request(overrides: Partial<CompileRequest> = {}): CompileRequest {
  const root = "/tmp/rvs-tenant";
  return {
    tenantId: "tenant-a",
    jobId: "job-a",
    attemptId: crypto.randomUUID(),
    leaseRoot: root,
    artifactPath: `${root}/normalized.mp4`,
    frameCount: 100,
    startMs: 0,
    endMs: 4000,
    modelManifest: { name: "fixture", version: "1", digest: "a".repeat(64) },
    runtimeManifest: { node: "24", python: "3.12", contract: "1.0.0" },
    guards: {
      lease: () => true,
      deletionEpoch: () => 2,
      restoreEpoch: () => 3,
      expectedDeletionEpoch: 2,
      expectedRestoreEpoch: 3,
    },
    ...overrides,
  };
}
class FakeChild extends EventEmitter implements Spawned {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 42;
  readonly kills: NodeJS.Signals[] = [];
  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.kills.push(signal);
    queueMicrotask(() => this.emit("close", null));
    return true;
  }
}
function factory(output: unknown, code = 0, delay = 0): ProcessFactory {
  return (_command, _args, _options) => {
    const child = new FakeChild();
    queueMicrotask(() => {
      child.stderr.emit(
        "data",
        `${JSON.stringify({ protocol: "rvs.compiler.v1", kind: "progress", stage: "preflight", fraction: 0.01 })}\n`,
      );
      child.stdout.emit("data", JSON.stringify(output));
      setTimeout(() => child.emit("close", code), delay);
    });
    return child;
  };
}
const validOutput = {
  protocol: "rvs.compiler.v1",
  kind: "evidence",
  bundle,
  stages: [{ name: "evidence", seconds: 1 }],
  rssGib: 1,
};
async function expectNoPublication(
  run: Promise<unknown>,
  attemptId: string,
): Promise<void> {
  await expect(run).rejects.toBeInstanceOf(Error);
  await expect(
    unlink(`/tmp/rvs-tenant/${attemptId}.evidence.json`),
  ).rejects.toMatchObject({ code: "ENOENT" });
}

describe("compiler orchestrator", () => {
  it("publishes a validated 100-frame evidence bundle", async () => {
    const fixture = request();
    const result = await new CompilerOrchestrator({
      python: "python",
      compilerArgs: [],
      spawn: factory(validOutput),
    }).compile(fixture);
    expect(result.kind).toBe("evidence");
    await unlink(`/tmp/rvs-tenant/${fixture.attemptId}.evidence.json`);
  });
  it("publishes no evidence for protocol, model, and crash failures", async () => {
    const corrupt = request();
    await expectNoPublication(
      new CompilerOrchestrator({
        python: "python",
        compilerArgs: [],
        spawn: factory({ nope: true }),
      }).compile(corrupt),
      corrupt.attemptId,
    );
    const missingModel = request({
      modelManifest: { name: "", version: "", digest: "bad" },
    });
    await expectNoPublication(
      new CompilerOrchestrator({
        python: "python",
        compilerArgs: [],
        spawn: factory(validOutput, 1),
      }).compile(missingModel),
      missingModel.attemptId,
    );
    const crash = request();
    await expectNoPublication(
      new CompilerOrchestrator({
        python: "python",
        compilerArgs: [],
        spawn: factory(validOutput, 1),
      }).compile(crash),
      crash.attemptId,
    );
  });
  it("rejects stale leases, epochs, network, and outside workspace without publication", async () => {
    const options = {
      python: "python",
      compilerArgs: [],
      spawn: factory(validOutput),
    };
    const stale = request({
      guards: { ...request().guards, lease: () => false },
    });
    await expectNoPublication(
      new CompilerOrchestrator(options).compile(stale),
      stale.attemptId,
    );
    const outside = request({ artifactPath: "/private/other.mp4" });
    await expectNoPublication(
      new CompilerOrchestrator(options).compile(outside),
      outside.attemptId,
    );
    const network = request();
    await expectNoPublication(
      new CompilerOrchestrator({ ...options, networkAllowed: true }).compile(
        network,
      ),
      network.attemptId,
    );
  });
  it("enforces true deadline, RSS, cancellation, and concurrent admission", async () => {
    const timeout = request();
    await expectNoPublication(
      new CompilerOrchestrator({
        python: "python",
        compilerArgs: [],
        spawn: factory(validOutput, 0, 40),
        stageCeilings: {
          total: 1,
          preflight: 0.001,
          models: 1,
          "all-frame-analysis": 1,
          "audio-and-mapping": 1,
          evidence: 1,
        },
      }).compile(timeout),
      timeout.attemptId,
    );
    const rss = request();
    await expectNoPublication(
      new CompilerOrchestrator({
        python: "python",
        compilerArgs: [],
        spawn: factory(validOutput, 0, 20),
        rssGib: () => 13,
      }).compile(rss),
      rss.attemptId,
    );
    const abort = new AbortController();
    abort.abort();
    const cancelled = request({ signal: abort.signal });
    await expectNoPublication(
      new CompilerOrchestrator({
        python: "python",
        compilerArgs: [],
        spawn: factory(validOutput),
      }).compile(cancelled),
      cancelled.attemptId,
    );
    const active = new CompilerOrchestrator({
      python: "python",
      compilerArgs: [],
      spawn: factory(validOutput, 0, 30),
    });
    const first = active.compile(request());
    await expect(active.compile(request())).rejects.toMatchObject({
      token: "COMPILER_ADMISSION_BUSY",
    });
    await first;
  });
  it("rechecks epochs after compile and reports progress stages", async () => {
    const fixture = request();
    let stale = false;
    const progress: { stage: string; fraction: number }[] = [];
    const guards = { ...fixture.guards, deletionEpoch: () => (stale ? 9 : 2) };
    const run = new CompilerOrchestrator({
      python: "python",
      compilerArgs: [],
      spawn: factory(validOutput),
    }).compile({
      ...fixture,
      guards,
      onProgress: (event) => {
        progress.push({ stage: event.stage, fraction: event.fraction });
        stale = true;
      },
    });
    await expectNoPublication(run, fixture.attemptId);
    expect(progress).toEqual([
      { stage: "preflight", fraction: 0 },
      { stage: "preflight", fraction: 0.01 },
      { stage: "evidence", fraction: 1 },
    ]);
  });

  it("terminates the compiler and preserves a progress reporting error", async () => {
    const fixture = request();
    const progressError = new Error("CANCEL_REQUESTED");
    let child: FakeChild | undefined;
    const run = new CompilerOrchestrator({
      python: "python",
      compilerArgs: [],
      spawn: () => {
        const spawned = new FakeChild();
        child = spawned;
        queueMicrotask(() => {
          spawned.stderr.emit(
            "data",
            `${JSON.stringify({ protocol: "rvs.compiler.v1", kind: "progress", stage: "preflight", fraction: 0.01 })}\n`,
          );
          spawned.stdout.emit("data", JSON.stringify(validOutput));
          setTimeout(() => spawned.emit("close", 0), 20);
        });
        return spawned;
      },
    }).compile({
      ...fixture,
      onProgress: (event) => {
        if (event.fraction !== 0.01) return;
        const rejected = Promise.reject(progressError);
        void rejected.catch(() => undefined);
        return rejected;
      },
    });

    try {
      await expect(run).rejects.toBe(progressError);
      expect(child?.kills).toEqual(["SIGTERM"]);
    } finally {
      await unlink(`/tmp/rvs-tenant/${fixture.attemptId}.evidence.json`).catch(
        () => undefined,
      );
    }
  });
});
