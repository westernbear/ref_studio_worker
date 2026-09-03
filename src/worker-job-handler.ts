import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CompilerOrchestrator } from "./compiler-orchestrator.js";
import { renderGeneratedDelivery } from "./gen-render-delivery.js";
import { renderEvidenceVideo } from "./evidence/render-evidence-video.js";
import { renderVfxLabelVideo } from "./evidence/vfx-labels.js";
import { runCommand } from "./process-runner.js";
import { renderWorkflowDelivery } from "./render-delivery.js";
import type { WorkerProgress } from "./worker-api.js";
import type { WorkerJobHandler } from "./worker-daemon.js";
import {
  reportPhase,
  WorkflowPayload,
  type CompileEvidenceInput,
  type CompileEvidenceResult,
  type WorkflowPipelineDependencies,
} from "./job-payload.js";
import { runGeneratePhase } from "./phases/generate.js";
import { runReferencePhase } from "./phases/reference.js";

export type {
  MaterialEndpoints,
  WorkflowPipelineDependencies,
} from "./job-payload.js";

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
  const renderLabels = dependencies.renderVfxLabelVideo ?? renderVfxLabelVideo;
  const renderGenerated =
    dependencies.renderGenerated ?? renderGeneratedDelivery;
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
        phase: reportPhase(payload),
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
      if (payload.phase === "assets" || payload.phase === "gen-render") {
        return await runGeneratePhase({
          job,
          payload,
          workspace,
          workRoot: root,
          signal,
          progress,
          dependencies,
          command,
          renderGenerated,
        });
      }
      return await runReferencePhase({
        job,
        payload,
        workspace,
        sourcePath,
        normalizedPath,
        outputPath,
        signal,
        progress,
        dependencies,
        command,
        compile,
        render,
        renderEvidence,
        renderLabels,
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  };
};
