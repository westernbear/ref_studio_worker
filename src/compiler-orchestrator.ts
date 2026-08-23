import { randomUUID, createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
  open,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { spawn } from "node:child_process";
import { z } from "zod";

const MAX_FRAMES = 240;
const INTERVAL_MS = 4_000;
const MAX_RSS_GIB = 12;
const DEFAULT_STAGE_CEILINGS = {
  preflight: 30,
  extract: 60,
  measure: 180,
  evidence: 1_800,
} as const;

const InputSchema = z.object({
  protocol: z.literal("rvs.compiler.v1"),
  tenantId: z.string().min(1),
  jobId: z.string().min(1),
  attemptId: z.string().min(1),
  artifactPath: z.string().min(1),
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int(),
  frameCount: z.number().int().positive().max(MAX_FRAMES),
  modelManifest: z.object({
    name: z.string().min(1),
    version: z.string().min(1),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  runtimeManifest: z.object({
    node: z.string().min(1),
    python: z.string().min(1),
    contract: z.string().min(1),
  }),
});
const OutputSchema = z.object({
  protocol: z.literal("rvs.compiler.v1"),
  kind: z.literal("evidence"),
  bundle: z.record(z.string(), z.unknown()),
  stages: z.array(
    z.object({ name: z.string(), seconds: z.number().nonnegative() }),
  ),
  rssGib: z.number().nonnegative(),
});
const ProgressSchema = z.object({
  protocol: z.literal("rvs.compiler.v1"),
  kind: z.literal("progress"),
  stage: z.string(),
  fraction: z.number().min(0).max(1),
});
type CompilerInput = z.infer<typeof InputSchema>;
type CompilerOutput = z.infer<typeof OutputSchema>;
export type CompilerProgress = z.infer<typeof ProgressSchema>;
export type StageCeilings = Readonly<
  Record<keyof typeof DEFAULT_STAGE_CEILINGS, number>
>;
export type CompilerGuards = Readonly<{
  lease: () => boolean;
  deletionEpoch: () => number;
  restoreEpoch: () => number;
  expectedDeletionEpoch: number;
  expectedRestoreEpoch: number;
}>;
export type Spawned = Readonly<{
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  kill: (signal?: NodeJS.Signals) => boolean;
  on: (event: string, listener: (...args: readonly unknown[]) => void) => void;
  pid: number | undefined;
}>;
export type ProcessFactory = (
  command: string,
  args: readonly string[],
  options: Readonly<{ cwd: string; env: Readonly<NodeJS.ProcessEnv> }>,
) => Spawned;
export type OrchestratorOptions = Readonly<{
  python: string;
  compilerArgs: readonly string[];
  stageCeilings?: StageCeilings;
  spawn?: ProcessFactory;
  now?: () => number;
  rssGib?: (pid: number | undefined) => number;
  networkAllowed?: boolean;
}>;
export type CompileRequest = Readonly<{
  tenantId: string;
  jobId: string;
  attemptId: string;
  leaseRoot: string;
  artifactPath: string;
  frameCount: number;
  startMs: number;
  endMs: number;
  modelManifest: CompilerInput["modelManifest"];
  runtimeManifest: CompilerInput["runtimeManifest"];
  guards: CompilerGuards;
  signal?: AbortSignal;
  onProgress?: (progress: CompilerProgress) => void;
}>;

export class CompilerOrchestratorError extends Error {
  readonly token: string;
  constructor(token: string) {
    super(token);
    this.name = "CompilerOrchestratorError";
    this.token = token;
  }
}
const safeError = (token: string): CompilerOrchestratorError =>
  new CompilerOrchestratorError(token);
const defaultSpawn: ProcessFactory = (command, args, options) => {
  const child = spawn(command, [...args], {
    cwd: options.cwd,
    env: { ...options.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    stdout: child.stdout,
    stderr: child.stderr,
    kill: (signal?: NodeJS.Signals) => child.kill(signal),
    pid: child.pid ?? undefined,
    on: (event, listener) => {
      child.on(event, (...args: unknown[]) => listener(...args));
    },
  };
};
const within = (root: string, candidate: string): boolean => {
  const r = relative(resolve(root), resolve(candidate));
  return r === "" || (!r.startsWith("..") && !isAbsolute(r));
};

export class CompilerOrchestrator {
  static #active = false;
  readonly #options: {
    readonly python: string;
    readonly compilerArgs: readonly string[];
    readonly stageCeilings: StageCeilings;
    readonly spawn: ProcessFactory;
    readonly now: () => number;
    readonly rssGib: (pid: number | undefined) => number;
    readonly networkAllowed: boolean;
  };
  constructor(options: OrchestratorOptions) {
    this.#options = {
      python: options.python,
      compilerArgs: options.compilerArgs,
      stageCeilings: options.stageCeilings ?? DEFAULT_STAGE_CEILINGS,
      spawn: options.spawn ?? defaultSpawn,
      now: options.now ?? Date.now,
      rssGib: options.rssGib ?? (() => 0),
      networkAllowed: options.networkAllowed ?? false,
    };
  }

  async compile(request: CompileRequest): Promise<CompilerOutput> {
    if (CompilerOrchestrator.#active)
      throw safeError("COMPILER_ADMISSION_BUSY");
    CompilerOrchestrator.#active = true;
    const workspace = await mkdtemp(join(tmpdir(), "rvs-compiler-"));
    const inputPath = join(workspace, "request.json");
    const outputPath = join(workspace, "evidence.json");
    try {
      if (this.#options.networkAllowed) throw safeError("NETWORK_NOT_ALLOWED");
      if (
        request.endMs - request.startMs !== INTERVAL_MS ||
        request.frameCount > MAX_FRAMES
      )
        throw safeError("TEMPORAL_CONTRACT_INVALID");
      if (!within(request.leaseRoot, request.artifactPath))
        throw safeError("WORKSPACE_BOUNDARY_VIOLATION");
      if (
        !request.guards.lease() ||
        request.guards.deletionEpoch() !==
          request.guards.expectedDeletionEpoch ||
        request.guards.restoreEpoch() !== request.guards.expectedRestoreEpoch
      )
        throw safeError("STALE_LEASE_OR_EPOCH");
      request.onProgress?.({
        protocol: "rvs.compiler.v1",
        kind: "progress",
        stage: "preflight",
        fraction: 0,
      });
      const input: CompilerInput = InputSchema.parse({
        protocol: "rvs.compiler.v1",
        tenantId: request.tenantId,
        jobId: request.jobId,
        attemptId: request.attemptId,
        artifactPath: request.artifactPath,
        startMs: request.startMs,
        endMs: request.endMs,
        frameCount: request.frameCount,
        modelManifest: request.modelManifest,
        runtimeManifest: request.runtimeManifest,
      });
      await writeFile(inputPath, JSON.stringify(input), { mode: 0o600 });
      const child = this.#options.spawn(
        this.#options.python,
        [...this.#options.compilerArgs, inputPath, outputPath],
        {
          cwd: workspace,
          env: {
            ...process.env,
            RVS_NO_NETWORK: "1",
            RVS_TENANT_ROOT: request.leaseRoot,
          },
        },
      );
      let stdout = "";
      let stderr = "";
      let progressBuffer = "";
      child.stdout.on("data", (chunk: unknown) => {
        if (typeof chunk === "string" || Buffer.isBuffer(chunk))
          stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk: unknown) => {
        if (typeof chunk !== "string" && !Buffer.isBuffer(chunk)) return;
        const text = chunk.toString();
        stderr += text;
        progressBuffer += text;
        const lines = progressBuffer.split("\n");
        progressBuffer = lines.pop() ?? "";
        for (const line of lines) {
          try {
            const progress = ProgressSchema.safeParse(JSON.parse(line));
            if (progress.success) request.onProgress?.(progress.data);
          } catch {}
        }
      });
      const abort = (): void => {
        child.kill("SIGTERM");
      };
      request.signal?.addEventListener("abort", abort, { once: true });
      const started = this.#options.now();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, this.#options.stageCeilings.evidence * 1000);
      const result = await new Promise<{ code: number | null }>(
        (resolveResult) =>
          child.on("close", (code: unknown) =>
            resolveResult({ code: typeof code === "number" ? code : null }),
          ),
      );
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", abort);
      if (request.signal?.aborted) throw safeError("COMPILER_CANCELLED");
      if (timedOut) throw safeError("COMPILER_DEADLINE");
      if (this.#options.rssGib(child.pid) > MAX_RSS_GIB)
        throw safeError("COMPILER_RSS_LIMIT");
      if (
        this.#options.now() - started >
        this.#options.stageCeilings.evidence * 1000
      )
        throw safeError("COMPILER_DEADLINE");
      if (result.code !== 0) {
        const token =
          stderr.match(/"token"\s*:\s*"([A-Z0-9_:-]+)"/)?.[1] ??
          "COMPILER_CRASH";
        console.error(
          JSON.stringify({
            event: "worker.compiler.failed",
            exitCode: result.code,
            token,
          }),
        );
        throw safeError(
          stderr.includes("NETWORK") ? "NETWORK_NOT_ALLOWED" : token,
        );
      }
      request.onProgress?.({
        protocol: "rvs.compiler.v1",
        kind: "progress",
        stage: "evidence",
        fraction: 1,
      });
      const parsed = OutputSchema.safeParse(
        JSON.parse(stdout || (await readFile(outputPath, "utf8"))),
      );
      if (!parsed.success) throw safeError("COMPILER_PROTOCOL_INVALID");
      if (!within(workspace, outputPath))
        throw safeError("WORKSPACE_BOUNDARY_VIOLATION");
      if (
        !request.guards.lease() ||
        request.guards.deletionEpoch() !==
          request.guards.expectedDeletionEpoch ||
        request.guards.restoreEpoch() !== request.guards.expectedRestoreEpoch
      )
        throw safeError("STALE_LEASE_OR_EPOCH");
      const digest = createHash("sha256")
        .update(JSON.stringify(parsed.data.bundle))
        .digest("hex");
      const evidence = { ...parsed.data, digest, correlationId: randomUUID() };
      const published = join(
        request.leaseRoot,
        `${request.attemptId}.evidence.json`,
      );
      await mkdir(dirname(published), { recursive: true });
      const temp = `${published}.${randomUUID()}.tmp`;
      const handle = await open(temp, "w", 0o600);
      await handle.writeFile(JSON.stringify(evidence));
      await handle.sync();
      await handle.close();
      await rename(temp, published);
      const dir = await open(dirname(published), "r");
      await dir.sync();
      await dir.close();
      return evidence;
    } catch (error) {
      if (
        error instanceof CompilerOrchestratorError ||
        error instanceof z.ZodError ||
        error instanceof SyntaxError
      ) {
        if (error instanceof z.ZodError || error instanceof SyntaxError)
          throw safeError("COMPILER_PROTOCOL_INVALID");
        throw error;
      }
      throw safeError("COMPILER_FAILED");
    } finally {
      CompilerOrchestrator.#active = false;
      await rm(workspace, { recursive: true, force: true });
    }
  }
}
