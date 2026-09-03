import { z } from "zod";
import { SceneSpecSchema } from "./contracts/index.js";
import type { MaterialProvider } from "./material-provider.js";
import { MATERIAL_EXTENSIONS } from "./resolve-scene-assets.js";
import { renderGeneratedDelivery } from "./gen-render-delivery.js";
import { renderEvidenceVideo } from "./evidence/render-evidence-video.js";
import { renderVfxLabelVideo } from "./evidence/vfx-labels.js";
import type { CommandRunner } from "./process-runner.js";
import {
  CompilationSchema,
  type RenderDeliveryInput,
} from "./render-delivery.js";
import type { WorkerApi, WorkerProgress } from "./worker-api.js";

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
const ScenePayload = {
  spec: SceneSpecSchema,
  specDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  attachmentIds: z.array(z.string().min(1)).max(20),
} as const;

export const MaterialEndpoints = z
  .object({
    video: z.string().url().nullable(),
    model3d: z.string().url().nullable(),
  })
  .strict();
export type MaterialEndpoints = z.infer<typeof MaterialEndpoints>;

export const WorkflowPayload = z
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
      .object({
        ...CommonPayload,
        ...ScenePayload,
        phase: z.literal("assets"),
        materialEndpoints: MaterialEndpoints.optional(),
      })
      .strict(),
    z
      .object({
        ...CommonPayload,
        ...ScenePayload,
        phase: z.literal("gen-render"),
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
export type WorkflowPayload = z.infer<typeof WorkflowPayload>;
export type GeneratePayload = Extract<
  WorkflowPayload,
  { phase: "assets" | "gen-render" }
>;
export type ReferencePayload = Exclude<WorkflowPayload, GeneratePayload>;

export type CompileEvidenceInput = Readonly<{
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
export type CompileEvidenceResult = Readonly<{
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
    | "uploadScenePackageArtifact"
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
  materialProvider?: MaterialProvider;
  materialProviderFactory?: (
    jobId: string,
    endpoints: MaterialEndpoints,
  ) => MaterialProvider;
  renderGenerated?: typeof renderGeneratedDelivery;
  workRoot?: string;
  renderDeadlineMs?: number;
  materialDeadlineMs?: number;
}>;

export type JobProgress = (
  stage: string,
  fraction: number,
  framesProcessed?: number | null,
  framesTotal?: number | null,
) => Promise<void>;

export type ClaimedJob = Readonly<{
  jobId: string;
  attemptId: string;
}>;

export const reportPhase = (
  payload: WorkflowPayload,
): WorkerProgress["phase"] =>
  payload.phase === "render" || payload.phase === "gen-render"
    ? "render"
    : "prepare";
