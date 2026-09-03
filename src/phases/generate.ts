import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { sha256Hex, type SceneSpec } from "../contracts/index.js";
import { renderGeneratedDelivery } from "../gen-render-delivery.js";
import {
  fileSha256,
  MATERIAL_EXTENSIONS,
  resolveSceneAssets,
  SAFE_ASSET_ID,
  type ResolvedSceneAsset,
} from "../resolve-scene-assets.js";
import type { CommandRunner } from "../process-runner.js";
import type {
  ClaimedJob,
  GeneratePayload,
  JobProgress,
  WorkflowPipelineDependencies,
} from "../job-payload.js";

export const runGeneratePhase = async (input: {
  job: ClaimedJob;
  payload: GeneratePayload;
  workspace: string;
  workRoot: string;
  signal: AbortSignal;
  progress: JobProgress;
  dependencies: WorkflowPipelineDependencies;
  command: CommandRunner;
  renderGenerated: typeof renderGeneratedDelivery;
}): Promise<Record<string, unknown>> => {
  const { job, payload, workspace, workRoot, signal, progress, dependencies } =
    input;
  if (sha256Hex(payload.spec) !== payload.specDigest)
    throw new Error("WORKER_SPEC_DIGEST_MISMATCH");
  if (payload.phase === "assets") {
    await progress("scene-assets", 0.2);
    const materialDeadline = AbortSignal.timeout(
      dependencies.materialDeadlineMs ?? 1_800_000,
    );
    const materialSignal = AbortSignal.any([signal, materialDeadline]);
    const resolved: readonly ResolvedSceneAsset[] = await resolveSceneAssets(
      {
        spec: payload.spec,
        attachmentIds: payload.attachmentIds,
        workspace,
        signal: materialSignal,
      },
      {
        downloadAttachment: (attachmentId, destinationPath, transfer) =>
          dependencies.api.downloadAttachment(
            job.jobId,
            attachmentId,
            destinationPath,
            transfer,
          ),
        ...(dependencies.materialProviderFactory
          ? {
              provider: dependencies.materialProviderFactory(
                job.jobId,
                payload.materialEndpoints ?? {
                  video: null,
                  model3d: null,
                },
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
  const spec: SceneSpec = payload.spec;
  const frameCount = spec.canvas.frameCount;
  await progress("scene-assets", 0.05, 0, frameCount);
  const assetDirectory = join(workspace, "scene-assets");
  await mkdir(assetDirectory, { recursive: true });
  const assetPaths = new Map<string, string>();
  const assetDigests = new Map<string, string>();
  const assetContentTypes = new Map<string, string>();
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
    if ((await fileSha256(destination)) !== asset.sha256)
      throw new Error("WORKER_ASSET_DIGEST_MISMATCH");
    assetPaths.set(asset.assetId, destination);
    assetDigests.set(asset.assetId, asset.sha256);
    assetContentTypes.set(asset.assetId, asset.contentType);
  }
  await progress("scene-render", 0.2, 0, frameCount);
  const generatedDeadline = AbortSignal.timeout(
    dependencies.renderDeadlineMs ?? 900_000,
  );
  const generatedSignal = AbortSignal.any([signal, generatedDeadline]);
  try {
    const outputPath = join(workspace, "delivery.mp4");
    const renderCachePath = join(
      workRoot,
      "rvs-render-cache",
      createHash("sha256")
        .update(`${payload.tenantId}\0${job.jobId}`)
        .digest("hex"),
    );
    const report = await input.renderGenerated(
      {
        spec,
        assetPaths,
        assetDigests,
        assetContentTypes,
        outPath: outputPath,
        signal: generatedSignal,
        scenePackagePath: join(workspace, "scene-package"),
        renderCachePath,
      },
      { runCommand: input.command },
    );
    await progress("upload", 0.95, frameCount, frameCount);
    const artifact = await dependencies.api.uploadGeneratedArtifact(
      job.jobId,
      outputPath,
      generatedSignal,
    );
    if (!report.scenePackageArchivePath)
      throw new Error("SCENE_PACKAGE_ARCHIVE_MISSING");
    const scenePackage = await dependencies.api.uploadScenePackageArtifact(
      job.jobId,
      report.scenePackageArchivePath,
      generatedSignal,
    );
    const safetySample = await dependencies.api.uploadSafetySample(
      job.jobId,
      report.safetySampleFramePath,
      generatedSignal,
    );
    const {
      runtimeSnapshotDigest: _runtimeSnapshotDigest,
      ...outgoingRuntime
    } = report.runtime;
    return {
      protocol: "rvs.worker.v1",
      phase: "gen-render",
      artifactId: artifact.artifactId,
      scenePackageArtifactId: scenePackage.artifactId,
      safetySampleArtifactId: safetySample.artifactId,
      report: {
        schema: report.schema,
        jobId: job.jobId,
        attemptId: job.attemptId,
        specDigest: report.specDigest,
        outputSha256: report.outputSha256,
        outputBytes: report.outputBytes,
        frameSha256: report.frameSha256,
        runtime: outgoingRuntime,
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
};
