import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { CompilerOrchestrator } from "./compiler-orchestrator.js";
import { normalizeMedia } from "./media-normalizer.js";
import { runCommand, type CommandRunner } from "./process-runner.js";
import {
  compileEvidenceScene,
  DELIVERY_FRAME_COUNT,
  renderWorkflowDelivery,
  type RenderDeliveryInput,
} from "./render-delivery.js";
import type { WorkerApi, WorkerProgress } from "./worker-api.js";
import type { WorkerJobHandler } from "./worker-daemon.js";

const Fps = z.union([
  z.literal(24),
  z.literal(25),
  z.literal(30),
  z.literal(50),
  z.literal(60),
]);
const Compilation = z
  .object({
    authoring: z
      .object({ digest: z.string().regex(/^[a-f0-9]{64}$/u) })
      .passthrough(),
    scene: z
      .object({ digest: z.string().regex(/^[a-f0-9]{64}$/u) })
      .passthrough(),
    browserPassSpec: z
      .object({ digest: z.string().regex(/^[a-f0-9]{64}$/u) })
      .passthrough(),
  })
  .strict();
const CommonPayload = {
  tenantId: z.string().min(1),
  uploadId: z.string().min(1),
  startFrame: z.number().int().nonnegative(),
  sourceFps: Fps,
  frameCount: z.number().int().min(96).max(240),
  deletionEpoch: z.number().int().nonnegative(),
  restoreEpoch: z.number().int().nonnegative(),
} as const;
const WorkflowPayload = z
  .discriminatedUnion("phase", [
    z.object({ ...CommonPayload, phase: z.literal("analyze") }).strict(),
    z
      .object({
        ...CommonPayload,
        phase: z.literal("compile"),
        evidence: z.record(z.string(), z.unknown()),
      })
      .strict(),
    z
      .object({
        ...CommonPayload,
        phase: z.literal("preview"),
        evidence: z.record(z.string(), z.unknown()),
        evidenceDigest: z.string().regex(/^[a-f0-9]{64}$/u),
        compilation: Compilation,
        browserPassSpecDigest: z.string().regex(/^[a-f0-9]{64}$/u),
      })
      .strict(),
    z
      .object({
        ...CommonPayload,
        phase: z.literal("render"),
        evidence: z.record(z.string(), z.unknown()),
        evidenceDigest: z.string().regex(/^[a-f0-9]{64}$/u),
        compilation: Compilation,
        browserPassSpecDigest: z.string().regex(/^[a-f0-9]{64}$/u),
      })
      .strict(),
  ])
  .superRefine((value, context) => {
    if (value.frameCount !== value.sourceFps * 4)
      context.addIssue({
        code: "custom",
        message: "frameCount must cover exactly four seconds",
        path: ["frameCount"],
      });
  });

type CompileEvidenceInput = Readonly<{
  tenantId: string;
  jobId: string;
  attemptId: string;
  workspace: string;
  normalizedPath: string;
  startMs: number;
  frameCount: number;
  deletionEpoch: number;
  restoreEpoch: number;
  signal: AbortSignal;
  onProgress: (stage: string, fraction: number) => Promise<void>;
}>;
type CompileEvidenceResult = Readonly<{
  evidence: Record<string, unknown>;
  evidenceDigest: string;
}>;
export type WorkflowPipelineDependencies = Readonly<{
  api: Pick<
    WorkerApi,
    "downloadSource" | "reportProgress" | "uploadArtifact" | "uploadPreview"
  >;
  runCommand?: CommandRunner;
  compileEvidence?: (
    input: CompileEvidenceInput,
  ) => Promise<CompileEvidenceResult>;
  renderDelivery?: (
    input: RenderDeliveryInput,
  ) => Promise<Record<string, unknown>>;
  workRoot?: string;
  renderDeadlineMs?: number;
}>;

const defaultCompileEvidence = async (
  input: CompileEvidenceInput,
): Promise<CompileEvidenceResult> => {
  const manifestPath =
    process.env.RVS_MODEL_MANIFEST_PATH ?? "/app/compiler/model-manifest.json";
  const manifest = await readFile(manifestPath);
  const manifestDigest = createHash("sha256").update(manifest).digest("hex");
  const compiler = new CompilerOrchestrator({
    python: process.env.RVS_PYTHON_PATH ?? "python3.12",
    compilerArgs: ["-m", "compiler.pipeline"],
  });
  let progressReports = Promise.resolve();
  let progressError: unknown;
  let progressFailed = false;
  const output = await compiler.compile({
    tenantId: input.tenantId,
    jobId: input.jobId,
    attemptId: input.attemptId,
    leaseRoot: input.workspace,
    artifactPath: input.normalizedPath,
    frameCount: input.frameCount,
    startMs: input.startMs,
    endMs: input.startMs + 4_000,
    modelManifest: {
      name: "rvs-model-pack",
      version: "1",
      digest: manifestDigest,
    },
    runtimeManifest: {
      node: "24.19.0",
      python: "3.12.14",
      contract: "1.0.0",
    },
    guards: {
      lease: () => !input.signal.aborted,
      deletionEpoch: () => input.deletionEpoch,
      restoreEpoch: () => input.restoreEpoch,
      expectedDeletionEpoch: input.deletionEpoch,
      expectedRestoreEpoch: input.restoreEpoch,
    },
    signal: input.signal,
    onProgress: (event) => {
      progressReports = progressReports.then(async () => {
        if (progressFailed) return;
        try {
          await input.onProgress(event.stage, event.fraction);
        } catch (error) {
          progressFailed = true;
          progressError = error;
        }
      });
    },
  });
  await progressReports;
  if (progressFailed) throw progressError;
  return {
    evidence: output.bundle,
    evidenceDigest: createHash("sha256")
      .update(JSON.stringify(output.bundle))
      .digest("hex"),
  };
};

export const createWorkflowJobHandler = (
  dependencies: WorkflowPipelineDependencies,
): WorkerJobHandler => {
  const command = dependencies.runCommand ?? runCommand;
  const compile = dependencies.compileEvidence ?? defaultCompileEvidence;
  const render = dependencies.renderDelivery ?? renderWorkflowDelivery;
  return async (job, signal) => {
    const payload = WorkflowPayload.parse(job.payload);
    const root = dependencies.workRoot ?? tmpdir();
    await mkdir(root, { recursive: true });
    const workspace = await mkdtemp(join(root, "rvs-worker-"));
    const sourcePath = join(workspace, "source.mp4");
    const normalizedPath = join(workspace, "normalized.mkv");
    const outputPath = join(workspace, "delivery.mp4");
    const progress = async (
      stage: string,
      fraction: number,
      framesProcessed: number | null = null,
      framesTotal: number | null = null,
    ): Promise<void> => {
      const update: WorkerProgress = {
        phase: payload.phase === "render" ? "render" : "prepare",
        stage,
        fraction,
        framesProcessed,
        framesTotal,
      };
      console.info(
        JSON.stringify({
          event: "worker.job.stage",
          jobId: job.jobId,
          attemptId: job.attemptId,
          ...update,
        }),
      );
      await dependencies.api.reportProgress(job.jobId, update, signal);
    };
    try {
      if (payload.phase === "compile") {
        await progress("scene-compile", 0.5);
        const compilation = compileEvidenceScene(
          payload.evidence,
          payload.tenantId,
        );
        const evidenceDigest = createHash("sha256")
          .update(JSON.stringify(payload.evidence))
          .digest("hex");
        await progress("scene-compile", 1);
        return {
          protocol: "rvs.worker.v1",
          phase: "compile",
          evidenceDigest,
          compilation,
        };
      }
      await progress("download", 0.05);
      const source = await dependencies.api.downloadSource(job.jobId, signal);
      await writeFile(sourcePath, source, { mode: 0o600 });
      await progress("ffprobe", 0.12);
      const normalized = await normalizeMedia(
        {
          inputPath: sourcePath,
          outputPath: normalizedPath,
          startFrame: payload.startFrame,
          sourceFps: payload.sourceFps,
          frameCount: payload.frameCount,
          workspace,
          signal,
          onProbeComplete: () => progress("normalize", 0.25),
        },
        command,
      );
      const renderContext = {
        tenantId: payload.tenantId,
        jobId: job.jobId,
        attemptId: job.attemptId,
        workspace,
        normalizedPath,
        outputPath,
        frameCount: payload.frameCount,
        sourceFps: payload.sourceFps,
        signal,
      };
      if (payload.phase === "analyze") {
        await progress("compiler", 0.55);
        const compiled = await compile({
          tenantId: payload.tenantId,
          jobId: job.jobId,
          attemptId: job.attemptId,
          workspace,
          normalizedPath,
          startMs: 0,
          frameCount: payload.frameCount,
          deletionEpoch: payload.deletionEpoch,
          restoreEpoch: payload.restoreEpoch,
          signal,
          onProgress: (stage, fraction) =>
            progress(`compiler:${stage}`, 0.55 + fraction * 0.25),
        });
        const compilation = compileEvidenceScene(
          compiled.evidence,
          payload.tenantId,
        );
        await progress("evidence", 1, payload.frameCount, payload.frameCount);
        return {
          protocol: "rvs.worker.v1",
          phase: "analyze",
          evidence: compiled.evidence,
          evidenceDigest: compiled.evidenceDigest,
          compilation,
          normalized: {
            sha256: normalized.sha256,
            durationMs: normalized.durationMs,
            fps: normalized.fps,
            frameCount: normalized.frameCount,
          },
        };
      }
      const evidenceDigest = createHash("sha256")
        .update(JSON.stringify(payload.evidence))
        .digest("hex");
      if (evidenceDigest !== payload.evidenceDigest)
        throw new Error("WORKER_EVIDENCE_DIGEST_MISMATCH");
      if (
        payload.browserPassSpecDigest !==
        payload.compilation.browserPassSpec.digest
      )
        throw new Error("IR_VERSION_MISMATCH");
      await progress("scene-render", 0.4, 0, DELIVERY_FRAME_COUNT);
      const mode = payload.phase === "preview" ? "preview" : "delivery";
      const renderController = new AbortController();
      const cancelRender = (): void => renderController.abort(signal.reason);
      signal.addEventListener("abort", cancelRender, { once: true });
      let renderTimedOut = false;
      const renderTimer = setTimeout(() => {
        renderTimedOut = true;
        renderController.abort(new Error("RENDER_DEADLINE"));
      }, dependencies.renderDeadlineMs ?? 900_000);
      try {
        const report = await render({
          ...renderContext,
          signal: renderController.signal,
          mode,
          evidence: payload.evidence,
          expectedCompilation: payload.compilation,
          onProgress: (framesProcessed, framesTotal) =>
            progress(
              "scene-render",
              0.4 + (framesProcessed / framesTotal) * 0.45,
              framesProcessed,
              framesTotal,
            ),
        });
        await progress(
          mode === "preview" ? "preview-upload" : "upload",
          0.95,
          DELIVERY_FRAME_COUNT,
          DELIVERY_FRAME_COUNT,
        );
        const bytes = await readFile(outputPath);
        if (mode === "preview") {
          const preview = await dependencies.api.uploadPreview(
            job.jobId,
            bytes,
            renderController.signal,
          );
          return {
            protocol: "rvs.worker.v1",
            phase: "preview",
            previewArtifactId: preview.artifactId,
            report,
          };
        }
        const artifact = await dependencies.api.uploadArtifact(
          job.jobId,
          bytes,
          renderController.signal,
        );
        return {
          protocol: "rvs.worker.v1",
          phase: "render",
          artifactId: artifact.artifactId,
          report,
        };
      } catch (error) {
        if (renderTimedOut) throw new Error("RENDER_DEADLINE");
        throw error;
      } finally {
        clearTimeout(renderTimer);
        signal.removeEventListener("abort", cancelRender);
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  };
};
