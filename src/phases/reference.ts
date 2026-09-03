import { createHash } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { projectEvidenceTracks } from "../evidence/tracks.js";
import { normalizeMedia } from "../media-normalizer.js";
import type { CommandRunner } from "../process-runner.js";
import {
  compileEvidenceScene,
  DELIVERY_FRAME_COUNT,
  renderWorkflowDelivery,
} from "../render-delivery.js";
import { renderEvidenceVideo } from "../evidence/render-evidence-video.js";
import { renderVfxLabelVideo } from "../evidence/vfx-labels.js";
import type {
  ClaimedJob,
  CompileEvidenceInput,
  CompileEvidenceResult,
  JobProgress,
  ReferencePayload,
  WorkflowPipelineDependencies,
} from "../job-payload.js";

const ShaderList = z.object({
  passList: z.array(z.object({ shader: z.string().nullable() }).passthrough()),
});
const sceneShaders = (spec: unknown): readonly string[] => {
  const parsed = ShaderList.safeParse(spec);
  if (!parsed.success) return [];
  return parsed.data.passList
    .map((entry) => entry.shader)
    .filter((shader): shader is string => shader !== null);
};

export const runReferencePhase = async (input: {
  job: ClaimedJob;
  payload: ReferencePayload;
  workspace: string;
  sourcePath: string;
  normalizedPath: string;
  outputPath: string;
  signal: AbortSignal;
  progress: JobProgress;
  dependencies: WorkflowPipelineDependencies;
  command: CommandRunner;
  compile: (input: CompileEvidenceInput) => Promise<CompileEvidenceResult>;
  render: typeof renderWorkflowDelivery;
  renderEvidence: typeof renderEvidenceVideo;
  renderLabels: typeof renderVfxLabelVideo;
}): Promise<Record<string, unknown>> => {
  const {
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
  } = input;
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
    payload.browserPassSpecDigest !== payload.compilation.browserPassSpec.digest
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
      : dependencies.api.uploadArtifact(job.jobId, outputPath, renderSignal));
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
    const { safetySampleFramePath, ...outgoingReport } = report as Record<
      string,
      unknown
    > & { safetySampleFramePath?: unknown; runtime?: unknown };
    if (outgoingReport.runtime && typeof outgoingReport.runtime === "object") {
      const { runtimeSnapshotDigest: _runtimeSnapshotDigest, ...runtime } =
        outgoingReport.runtime as Record<string, unknown> & {
          runtimeSnapshotDigest?: unknown;
        };
      outgoingReport.runtime = runtime;
    }
    if (mode === "preview") {
      const labeledPath = join(workspace, "preview-labeled.mp4");
      await renderLabels(
        {
          previewPath: outputPath,
          outputPath: labeledPath,
          workspace,
          shaders: sceneShaders(payload.compilation.browserPassSpec),
          signal: renderSignal,
        },
        command,
      );
      const labeled = await dependencies.api.uploadPreviewLabeled(
        job.jobId,
        labeledPath,
        renderSignal,
      );
      return {
        protocol: "rvs.worker.v1",
        phase: "preview",
        previewArtifactId: artifact.artifactId,
        previewLabeledArtifactId: labeled.artifactId,
        report: outgoingReport,
      };
    }
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
};
