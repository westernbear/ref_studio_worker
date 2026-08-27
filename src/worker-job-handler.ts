import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { CompilerOrchestrator } from "./compiler-orchestrator.js";
import {
  SceneSpecSchema,
  sha256Hex,
  type SceneSpec,
} from "./contracts/index.js";
import { renderGeneratedDelivery } from "./gen-render-delivery.js";
import type { MaterialProvider } from "./material-provider.js";
import {
  fileSha256,
  MATERIAL_EXTENSIONS,
  resolveSceneAssets,
  SAFE_ASSET_ID,
  type ResolvedSceneAsset,
} from "./resolve-scene-assets.js";
import { projectEvidenceTracks } from "./evidence/tracks.js";
import { renderEvidenceVideo } from "./evidence/render-evidence-video.js";
import { renderVfxLabelVideo } from "./evidence/vfx-labels.js";
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
// The generate track's two phases read the authored scene instead of the
// measured evidence -- the API does not send the evidence bundle to either.
const ScenePayload = {
  spec: SceneSpecSchema,
  specDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  attachmentIds: z.array(z.string().min(1)).max(20),
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
    z
      .object({ ...CommonPayload, ...ScenePayload, phase: z.literal("assets") })
      .strict(),
    z
      .object({
        ...CommonPayload,
        ...ScenePayload,
        phase: z.literal("gen-render"),
        // What the `assets` phase already stored. Each is fetched back and
        // re-hashed against the digest the API bound it to.
        assets: z
          .array(
            z
              .object({
                assetId: z.string().min(1),
                artifactId: z.string().min(1),
                sha256: z.string().regex(/^[a-f0-9]{64}$/u),
                contentType: z.enum(
                  Object.keys(MATERIAL_EXTENSIONS) as [string, ...string[]],
                ),
              })
              .strict(),
          )
          .max(64),
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
    | "uploadPreviewLabeled"
    | "uploadEvidenceVideo"
    | "uploadSafetySample"
    | "uploadGeneratedArtifact"
    | "downloadAttachment"
    | "downloadSceneAsset"
    | "uploadSceneAsset"
  >;
  runCommand?: CommandRunner;
  compileEvidence?: (
    input: CompileEvidenceInput,
  ) => Promise<CompileEvidenceResult>;
  renderDelivery?: (
    input: RenderDeliveryInput,
  ) => Promise<Record<string, unknown>>;
  renderEvidenceVideo?: typeof renderEvidenceVideo;
  renderVfxLabelVideo?: typeof renderVfxLabelVideo;
  // The generate track. `materialProvider` is a fixed instance (tests
  // inject it directly, e.g. a fake that never varies per job).
  // `materialProviderFactory` is how a real provider is wired: it is
  // called once per job, with that job's id, because the API's material
  // endpoint is addressed by job id and a provider built at daemon
  // startup cannot know it yet. `materialProvider` wins if both are set.
  // Left both unset, resolve-scene-assets falls back to the fail-closed
  // stub and any scene needing new material fails its job.
  materialProvider?: MaterialProvider;
  materialProviderFactory?: (jobId: string) => MaterialProvider;
  renderGenerated?: typeof renderGeneratedDelivery;
  workRoot?: string;
  renderDeadlineMs?: number;
}>;

// browserPassSpec is typed as passthrough, so read the shader list defensively
// rather than asserting a shape the schema does not promise.
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
        phase:
          payload.phase === "render" || payload.phase === "gen-render"
            ? "render"
            : "prepare",
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
      // Neither generate-track phase reads the reference source, so both
      // return before the download/normalize steps below.
      if (payload.phase === "assets" || payload.phase === "gen-render") {
        // The spec travelled as JSON; the digest the API bound this job to
        // is the digest of the document it sent, so re-derive it rather
        // than trusting the field beside it.
        if (sha256Hex(payload.spec) !== payload.specDigest)
          throw new Error("WORKER_SPEC_DIGEST_MISMATCH");
      }
      if (payload.phase === "assets") {
        await progress("scene-assets", 0.2);
        const resolved: readonly ResolvedSceneAsset[] =
          await resolveSceneAssets(
            {
              spec: payload.spec,
              attachmentIds: payload.attachmentIds,
              workspace,
              signal,
            },
            {
              downloadAttachment: (attachmentId, destinationPath, transfer) =>
                dependencies.api.downloadAttachment(
                  job.jobId,
                  attachmentId,
                  destinationPath,
                  transfer,
                ),
              ...(dependencies.materialProvider
                ? { provider: dependencies.materialProvider }
                : dependencies.materialProviderFactory
                  ? {
                      provider: dependencies.materialProviderFactory(
                        job.jobId,
                      ),
                    }
                  : {}),
            },
          );
        const assets = [];
        for (const asset of resolved) {
          const uploaded = await dependencies.api.uploadSceneAsset(
            job.jobId,
            asset.assetId,
            asset.path,
            asset.contentType,
            signal,
          );
          assets.push({
            assetId: asset.assetId,
            artifactId: uploaded.artifactId,
            sha256: asset.sha256,
            provenance: asset.provenance,
          });
        }
        await progress("scene-assets", 1);
        return {
          protocol: "rvs.worker.v1",
          phase: "assets",
          specDigest: payload.specDigest,
          assets,
        };
      }
      if (payload.phase === "gen-render") {
        const spec: SceneSpec = payload.spec;
        const frameCount = spec.canvas.frameCount;
        await progress("scene-assets", 0.05, 0, frameCount);
        const assetDirectory = join(workspace, "scene-assets");
        await mkdir(assetDirectory, { recursive: true });
        const assetPaths = new Map<string, string>();
        for (const asset of payload.assets) {
          if (!SAFE_ASSET_ID.test(asset.assetId))
            throw new Error("WORKER_ASSET_ID_UNSAFE");
          const destination = join(
            assetDirectory,
            `${asset.assetId}.${MATERIAL_EXTENSIONS[asset.contentType as keyof typeof MATERIAL_EXTENSIONS]}`,
          );
          await dependencies.api.downloadSceneAsset(
            job.jobId,
            asset.assetId,
            destination,
            signal,
          );
          // The API bound this artifact to this hash; bytes that do not
          // match are not the asset this scene was resolved against.
          if ((await fileSha256(destination)) !== asset.sha256)
            throw new Error("WORKER_ASSET_DIGEST_MISMATCH");
          assetPaths.set(asset.assetId, destination);
        }
        await progress("scene-render", 0.2, 0, frameCount);
        const generatedDeadline = AbortSignal.timeout(
          dependencies.renderDeadlineMs ?? 900_000,
        );
        const generatedSignal = AbortSignal.any([signal, generatedDeadline]);
        try {
          const report = await renderGenerated(
            { spec, assetPaths, outPath: outputPath },
            { runCommand: command },
          );
          await progress("upload", 0.95, frameCount, frameCount);
          const artifact = await dependencies.api.uploadGeneratedArtifact(
            job.jobId,
            outputPath,
            generatedSignal,
          );
          const safetySample = await dependencies.api.uploadSafetySample(
            job.jobId,
            report.safetySampleFramePath,
            generatedSignal,
          );
          return {
            protocol: "rvs.worker.v1",
            phase: "gen-render",
            artifactId: artifact.artifactId,
            safetySampleArtifactId: safetySample.artifactId,
            report: {
              schema: report.schema,
              jobId: job.jobId,
              attemptId: job.attemptId,
              specDigest: report.specDigest,
              outputSha256: report.outputSha256,
              outputBytes: report.outputBytes,
              frameSha256: report.frameSha256,
              runtime: report.runtime,
              qc: report.qc,
            },
          };
        } catch (error) {
          if (signal.aborted)
            throw signal.reason instanceof Error
              ? signal.reason
              : new Error("WORKER_JOB_CANCELLED");
          if (generatedDeadline.aborted) throw new Error("RENDER_DEADLINE");
          throw error;
        }
      }
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
        // safetySampleFramePath is a local worker-filesystem path, meaningful
        // only for the upload below -- strip it before the report is sent to
        // the API, whose RenderReport schema is .strict() (both preview and
        // delivery reports extend it, so both must drop this key).
        const { safetySampleFramePath, ...outgoingReport } = report as Record<
          string,
          unknown
        > & { safetySampleFramePath?: unknown };
        if (mode === "preview") {
          // The animatic ships in two forms: a clean one for judging the
          // motion, and one captioned with the treatments it applies, which
          // is what the review comparison puts beside the reference.
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
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  };
};
