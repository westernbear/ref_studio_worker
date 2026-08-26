import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { CompilerOrchestrator } from "./compiler-orchestrator.js";
import { projectEvidenceTracks } from "./evidence/tracks.js";
import { renderEvidenceVideo } from "./evidence/render-evidence-video.js";
import { normalizeMedia } from "./media-normalizer.js";
import { runCommand, type CommandRunner } from "./process-runner.js";
import {
  compileEvidenceScene,
  CompilationSchema,
  DELIVERY_FRAME_COUNT,
  renderWorkflowDelivery,
  type RenderDeliveryInput,
} from "./render-delivery.js";
import type { WorkerApi, WorkerProgress } from "./worker-api.js";
import type { WorkerJobHandler } from "./worker-daemon.js";

// allow: SIZE_OK - workflow phase routing stays beside its digest and lease checks.

const Fps = z.union([
  z.literal(24),
  z.literal(25),
  z.literal(30),
  z.literal(50),
  z.literal(60),
]);
const CommonPayload = {
  tenantId: z.string().min(1),
  uploadId: z.string().min(1),
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  startFrame: z.number().int().nonnegative(),
  sourceFps: Fps,
  frameCount: z.number().int().min(96).max(240),
  deletionEpoch: z.number().int().nonnegative(),
  restoreEpoch: z.number().int().nonnegative(),
} as const;
const RenderPayload = {
  evidence: z.record(z.string(), z.unknown()),
  evidenceDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  compilation: CompilationSchema,
  browserPassSpecDigest: z.string().regex(/^[a-f0-9]{64}$/u),
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
        phase: z.literal("evidence-video"),
        evidence: z.record(z.string(), z.unknown()),
      })
      .strict(),
    z
      .object({
        ...CommonPayload,
        ...RenderPayload,
        phase: z.literal("preview"),
      })
      .strict(),
    z
      .object({
        ...CommonPayload,
        ...RenderPayload,
        phase: z.literal("render"),
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
    | "downloadSource"
    | "reportProgress"
    | "uploadArtifact"
    | "uploadPreview"
    | "uploadEvidenceVideo"
    | "uploadSafetySample"
  >;
  runCommand?: CommandRunner;
  compileEvidence?: (
    input: CompileEvidenceInput,
  ) => Promise<CompileEvidenceResult>;
  renderDelivery?: (
    input: RenderDeliveryInput,
  ) => Promise<Record<string, unknown>>;
  renderEvidenceVideo?: typeof renderEvidenceVideo;
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
    onProgress: (event) => input.onProgress(event.stage, event.fraction),
  });
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
  const renderEvidence =
    dependencies.renderEvidenceVideo ?? renderEvidenceVideo;
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
          tenantId: payload.tenantId,
          workflowPhase: payload.phase,
          deletionEpoch: payload.deletionEpoch,
          restoreEpoch: payload.restoreEpoch,
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
      await dependencies.api.downloadSource(
        job.jobId,
        sourcePath,
        payload.sourceSha256,
        signal,
      );
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
      if (payload.phase === "evidence-video") {
        await progress("evidence-overlay", 0.5);
        const tracks = projectEvidenceTracks(payload.evidence);
        await renderEvidence(
          {
            normalizedPath,
            outputPath,
            workspace,
            tracks,
            fps: payload.sourceFps,
            signal,
          },
          command,
        );
        await progress("evidence-video-upload", 0.95);
        const artifact = await dependencies.api.uploadEvidenceVideo(
          job.jobId,
          outputPath,
          signal,
        );
        return {
          protocol: "rvs.worker.v1",
          phase: "evidence-video",
          evidenceVideoArtifactId: artifact.artifactId,
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
      const renderDeadline = AbortSignal.timeout(
        dependencies.renderDeadlineMs ?? 900_000,
      );
      const renderSignal = AbortSignal.any([signal, renderDeadline]);
      try {
        const report = await render({
          ...renderContext,
          signal: renderSignal,
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
        const artifactKind = mode === "preview" ? "preview" : "delivery";
        console.info(
          JSON.stringify({
            event: "worker.artifact.upload.started",
            jobId: job.jobId,
            attemptId: job.attemptId,
            tenantId: payload.tenantId,
            phase: payload.phase,
            deletionEpoch: payload.deletionEpoch,
            restoreEpoch: payload.restoreEpoch,
            artifactKind,
          }),
        );
        const artifact = await (mode === "preview"
          ? dependencies.api.uploadPreview(job.jobId, outputPath, renderSignal)
          : dependencies.api.uploadArtifact(
              job.jobId,
              outputPath,
              renderSignal,
            ));
        console.info(
          JSON.stringify({
            event: "worker.artifact.upload.completed",
            jobId: job.jobId,
            attemptId: job.attemptId,
            tenantId: payload.tenantId,
            phase: payload.phase,
            deletionEpoch: payload.deletionEpoch,
            restoreEpoch: payload.restoreEpoch,
            artifactKind,
            artifactId: artifact.artifactId,
            sha256: artifact.sha256,
            sizeBytes: artifact.sizeBytes,
          }),
        );
        if (mode === "preview") {
          return {
            protocol: "rvs.worker.v1",
            phase: "preview",
            previewArtifactId: artifact.artifactId,
            report,
          };
        }
        // safetySampleFramePath is a local worker-filesystem path, meaningful
        // only for the upload below -- strip it before the report is sent to
        // the API, whose RenderReport schema is .strict().
        const { safetySampleFramePath, ...outgoingReport } = report as Record<
          string,
          unknown
        > & { safetySampleFramePath?: unknown };
        const safetySample =
          typeof safetySampleFramePath === "string"
            ? await dependencies.api.uploadSafetySample(
                job.jobId,
                safetySampleFramePath,
                renderSignal,
              )
            : null;
        return {
          protocol: "rvs.worker.v1",
          phase: "render",
          artifactId: artifact.artifactId,
          safetySampleArtifactId: safetySample?.artifactId ?? null,
          report: outgoingReport,
        };
      } catch (error) {
        if (signal.aborted)
          throw signal.reason instanceof Error
            ? signal.reason
            : new Error("WORKER_JOB_CANCELLED");
        if (renderDeadline.aborted) throw new Error("RENDER_DEADLINE");
        throw error;
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  };
};
