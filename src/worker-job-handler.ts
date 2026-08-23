import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { CompilerOrchestrator } from "./compiler-orchestrator.js";
import { normalizeMedia } from "./media-normalizer.js";
import { runCommand, type CommandRunner } from "./process-runner.js";
import {
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
const WorkflowPayload = z
  .object({
    tenantId: z.string().min(1),
    uploadId: z.string().min(1),
    startFrame: z.number().int().nonnegative(),
    sourceFps: Fps,
    frameCount: z.number().int().min(96).max(240),
    phase: z.enum(["prepare", "render"]),
    evidence: z.record(z.string(), z.unknown()).optional(),
    evidenceDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.frameCount !== value.sourceFps * 4)
      context.addIssue({
        code: "custom",
        message: "frameCount must cover exactly four seconds",
        path: ["frameCount"],
      });
    if (value.phase === "render" && (!value.evidence || !value.evidenceDigest))
      context.addIssue({
        code: "custom",
        message: "render evidence and digest are required",
        path: ["evidence"],
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
      deletionEpoch: () => 0,
      restoreEpoch: () => 0,
      expectedDeletionEpoch: 0,
      expectedRestoreEpoch: 0,
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
        phase: payload.phase,
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
      if (payload.phase === "prepare") {
        await progress("compiler", 0.55);
        const compiled = await compile({
          tenantId: payload.tenantId,
          jobId: job.jobId,
          attemptId: job.attemptId,
          workspace,
          normalizedPath,
          startMs: 0,
          frameCount: payload.frameCount,
          signal,
          onProgress: (stage, fraction) =>
            progress(`compiler:${stage}`, 0.55 + fraction * 0.25),
        });
        await progress("preview-render", 0.8, 0, payload.frameCount);
        await render({
          ...renderContext,
          mode: "preview",
          evidence: compiled.evidence,
          onProgress: (framesProcessed, framesTotal) =>
            progress(
              "preview-render",
              0.8 + (framesProcessed / framesTotal) * 0.15,
              framesProcessed,
              framesTotal,
            ),
        });
        await progress(
          "preview-upload",
          0.98,
          payload.frameCount,
          payload.frameCount,
        );
        const preview = await dependencies.api.uploadPreview(
          job.jobId,
          await readFile(outputPath),
          signal,
        );
        await progress("evidence", 1, payload.frameCount, payload.frameCount);
        return {
          protocol: "rvs.worker.v1",
          phase: "prepare",
          evidence: compiled.evidence,
          evidenceDigest: compiled.evidenceDigest,
          previewArtifactId: preview.artifactId,
          normalized: {
            sha256: normalized.sha256,
            durationMs: normalized.durationMs,
            fps: normalized.fps,
            frameCount: normalized.frameCount,
          },
        };
      }
      if (!payload.evidence) throw new Error("WORKER_EVIDENCE_MISSING");
      const evidenceDigest = createHash("sha256")
        .update(JSON.stringify(payload.evidence))
        .digest("hex");
      if (evidenceDigest !== payload.evidenceDigest)
        throw new Error("WORKER_EVIDENCE_DIGEST_MISMATCH");
      await progress("scene-render", 0.4, 0, payload.frameCount);
      const report = await render({
        ...renderContext,
        mode: "delivery",
        evidence: payload.evidence,
        onProgress: (framesProcessed, framesTotal) =>
          progress(
            "scene-render",
            0.4 + (framesProcessed / framesTotal) * 0.45,
            framesProcessed,
            framesTotal,
          ),
      });
      await progress("upload", 0.95, payload.frameCount, payload.frameCount);
      const artifact = await dependencies.api.uploadArtifact(
        job.jobId,
        await readFile(outputPath),
        signal,
      );
      return {
        protocol: "rvs.worker.v1",
        phase: "render",
        artifactId: artifact.artifactId,
        report,
      };
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  };
};
