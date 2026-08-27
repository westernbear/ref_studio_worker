import { createHash } from "node:crypto";
import { createWriteStream, openAsBlob } from "node:fs";
import { rm, stat } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import {
  MATERIAL_CONTENT_TYPES,
  type MaterialProvenance,
  type MaterialRequest,
} from "./material-provider.js";
import type { WorkerConfig } from "./worker-config.js";
import type { WorkerPreflightReport } from "./worker-preflight.js";

const RegisterResponse = z.object({
  workerId: z.string().min(1),
  sessionToken: z.string().min(1),
});
const WorkerResponse = z.object({ workerId: z.string().min(1) });
const Job = z.object({
  jobId: z.string().min(1),
  attemptId: z.string().min(1),
  leaseToken: z.string().min(1),
  leaseExpiresAt: z.iso.datetime(),
  payload: z.record(z.string(), z.unknown()).default({}),
});
const ClaimResponse = z.object({ job: Job.nullable() });
const OkResponse = z.object({ ok: z.literal(true) });
const ArtifactUploadResponse = z.object({
  artifactId: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  sizeBytes: z.number().int().positive(),
});
const MaterialResponse = z.object({
  contentType: z.enum(MATERIAL_CONTENT_TYPES),
  // Base64, not a stream: the material endpoint answers a single JSON
  // request with a single JSON response, same as every other worker<->API
  // call this client makes -- see material-provider.ts's header comment on
  // why the seam is one request in, one answer out, no partial success.
  bytesBase64: z.string().min(1),
  provenance: z.object({
    tool: z.string().min(1),
    prompt: z.string().min(1),
    seed: z.number().optional(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }),
});
export type GeneratedMaterialResponse = Readonly<{
  bytes: Uint8Array;
  contentType: (typeof MATERIAL_CONTENT_TYPES)[number];
  provenance: MaterialProvenance;
}>;
export type WorkerJob = z.infer<typeof Job>;
export type WorkerProgress = Readonly<{
  phase: "prepare" | "render";
  stage: string;
  fraction: number;
  framesProcessed: number | null;
  framesTotal: number | null;
}>;
export type ArtifactUpload = z.infer<typeof ArtifactUploadResponse>;
export type WorkerApi = Readonly<{
  register(): Promise<void>;
  heartbeat(): Promise<void>;
  claim(): Promise<WorkerJob | null>;
  complete(jobId: string, result: unknown): Promise<void>;
  fail(jobId: string, message: string): Promise<void>;
  acknowledgeCancellation(jobId: string): Promise<void>;
  downloadSource(
    jobId: string,
    destinationPath: string,
    expectedSha256: string,
    signal: AbortSignal,
  ): Promise<void>;
  reportProgress(
    jobId: string,
    progress: WorkerProgress,
    signal: AbortSignal,
  ): Promise<void>;
  uploadArtifact(
    jobId: string,
    sourcePath: string,
    signal: AbortSignal,
  ): Promise<ArtifactUpload>;
  uploadPreview(
    jobId: string,
    sourcePath: string,
    signal: AbortSignal,
  ): Promise<ArtifactUpload>;
  uploadPreviewLabeled(
    jobId: string,
    sourcePath: string,
    signal: AbortSignal,
  ): Promise<ArtifactUpload>;
  uploadEvidenceVideo(
    jobId: string,
    sourcePath: string,
    signal: AbortSignal,
  ): Promise<ArtifactUpload>;
  uploadSafetySample(
    jobId: string,
    sourcePath: string,
    signal: AbortSignal,
  ): Promise<ArtifactUpload>;
  // The generate track's film. A separate route from uploadArtifact so the
  // API stages it under its own artifact kind.
  uploadGeneratedArtifact(
    jobId: string,
    sourcePath: string,
    signal: AbortSignal,
  ): Promise<ArtifactUpload>;
  // The generate track's three extra transfers. Brand attachments live in
  // the API's memory, so the `assets` phase has no other way to read one;
  // resolved assets are stored by the API so the `gen-render` phase need
  // not run on the same worker, or the same disk, as the phase that
  // produced them.
  downloadAttachment(
    jobId: string,
    attachmentId: string,
    destinationPath: string,
    signal: AbortSignal,
  ): Promise<{ readonly contentType: string }>;
  downloadSceneAsset(
    jobId: string,
    assetId: string,
    destinationPath: string,
    signal: AbortSignal,
  ): Promise<{ readonly contentType: string }>;
  uploadSceneAsset(
    jobId: string,
    assetId: string,
    sourcePath: string,
    contentType: string,
    signal: AbortSignal,
  ): Promise<ArtifactUpload>;
  // The `assets` phase's one way to get new material: the worker has no
  // outbound network (see docker-compose.yml's worker-internal network),
  // so this asks the API -- which holds the vendor key -- to make the call
  // and hand back bytes plus provenance.
  requestMaterial(
    jobId: string,
    request: MaterialRequest,
    signal: AbortSignal,
  ): Promise<GeneratedMaterialResponse>;
}>;
export type Fetcher = (
  input: URL | RequestInfo,
  init?: RequestInit,
) => Promise<Response>;

export class WorkerApiError extends Error {
  readonly path: string;
  readonly status: number | null;
  readonly code: string | null;

  constructor(
    path: string,
    status: number | null,
    message: string,
    code: string | null = null,
  ) {
    super(message);
    this.name = "WorkerApiError";
    this.path = path;
    this.status = status;
    this.code = code;
  }
}

const preview = (body: string): string =>
  body.replace(/\s+/gu, " ").trim().slice(0, 120);
const isJson = (contentType: string): boolean =>
  contentType.toLowerCase().includes("application/json");
const errorCode = (body: string, contentType: string): string | null => {
  if (!isJson(contentType)) return null;
  try {
    const parsed: unknown = JSON.parse(body);
    const error =
      parsed !== null && typeof parsed === "object"
        ? Reflect.get(parsed, "error")
        : null;
    const value =
      error !== null && typeof error === "object"
        ? Reflect.get(error, "code")
        : null;
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
};

export function createWorkerApi(
  config: WorkerConfig,
  fetcher: Fetcher = fetch,
  preflight?: WorkerPreflightReport,
): WorkerApi {
  let sessionToken: string | null = null;
  const leases = new Map<string, string>();
  async function readResponse<T>(
    path: string,
    init: RequestInit,
    timeoutMs: number,
    signal: AbortSignal | undefined,
    read: (response: Response, signal: AbortSignal) => Promise<T>,
    token: string,
    leaseToken?: string,
  ): Promise<Readonly<{ response: Response; body: T }>> {
    const timeout = AbortSignal.timeout(timeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const response = await fetcher(`${config.apiBaseUrl}${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${token}`,
          ...(leaseToken ? { "X-Worker-Lease": leaseToken } : {}),
          ...init.headers,
        },
        signal: requestSignal,
      });
      return { response, body: await read(response, requestSignal) };
    } catch (error) {
      if (error instanceof WorkerApiError) throw error;
      if (error instanceof Error)
        throw new WorkerApiError(
          path,
          null,
          `worker API fetch failed for ${path}; check RVS_API_BASE_URL and network reachability (${timeout.aborted && !signal?.aborted ? `request timed out after ${timeoutMs}ms` : error.message})`,
        );
      throw error;
    }
  }

  const parseJson = <T>(
    path: string,
    response: Response,
    responseBody: string,
    schema: z.ZodType<T>,
  ): T => {
    if (!response.ok) {
      const code = errorCode(
        responseBody,
        response.headers.get("content-type") ?? "",
      );
      throw new WorkerApiError(
        path,
        response.status,
        `worker API request failed (${response.status}) for ${path}: ${preview(responseBody)}`,
        code,
      );
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (!isJson(contentType))
      throw new WorkerApiError(
        path,
        response.status,
        `worker API returned non-JSON (${contentType || "no content-type"}) for ${path}; check RVS_API_BASE_URL points to the API server, not the web server`,
      );
    try {
      return schema.parse(JSON.parse(responseBody));
    } catch (error) {
      if (error instanceof SyntaxError)
        throw new WorkerApiError(
          path,
          response.status,
          `worker API returned invalid JSON for ${path}: ${preview(responseBody)}`,
        );
      throw error;
    }
  };

  async function post<T>(
    path: string,
    body: unknown,
    schema: z.ZodType<T>,
    signal?: AbortSignal,
    token = sessionToken,
    leaseToken?: string,
  ): Promise<T> {
    if (!token)
      throw new WorkerApiError(path, null, "worker session is not registered");
    const result = await readResponse(
      path,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      config.apiRequestTimeoutMs,
      signal,
      (response) => response.text(),
      token,
      leaseToken,
    );
    return parseJson(path, result.response, result.body, schema);
  }
  const prefix = `/v1/workers/${encodeURIComponent(config.workerId)}`;
  const leaseFor = (jobId: string): string => {
    const lease = leases.get(jobId);
    if (!lease)
      throw new WorkerApiError(
        `${prefix}/jobs/${encodeURIComponent(jobId)}`,
        null,
        "worker job lease is not available",
      );
    return lease;
  };
  const uploadTo = async (
    path: string,
    jobId: string,
    sourcePath: string,
    signal: AbortSignal,
    contentType: string,
  ): Promise<ArtifactUpload> => {
    const source = await openAsBlob(sourcePath, { type: contentType });
    const init = {
      method: "POST",
      headers: {
        "content-type": contentType,
        "content-length": String(source.size),
      },
      body: source,
    } satisfies RequestInit;
    const result = await readResponse<string>(
      path,
      init,
      config.mediaRequestTimeoutMs,
      signal,
      (response) => response.text(),
      sessionToken ?? "",
      leaseFor(jobId),
    );
    return parseJson(
      path,
      result.response,
      result.body,
      ArtifactUploadResponse,
    );
  };
  const upload = (
    jobId: string,
    kind:
      | "artifact"
      | "generated-artifact"
      | "preview-artifact"
      | "preview-labeled-artifact"
      | "evidence-video-artifact"
      | "safety-sample-artifact",
    sourcePath: string,
    signal: AbortSignal,
    contentType: string = "video/mp4",
  ): Promise<ArtifactUpload> =>
    uploadTo(
      `${prefix}/jobs/${encodeURIComponent(jobId)}/${kind}`,
      jobId,
      sourcePath,
      signal,
      contentType,
    );
  // Streams a lease-fenced file straight to disk and reports what the API
  // said it is. Deliberately not downloadSource: there is no expected hash
  // to check here at fetch time -- the caller checks the digest it was
  // given by its own payload, which is the value the API bound the artifact
  // to, not one this response could restate.
  const downloadFile = async (
    path: string,
    jobId: string,
    destinationPath: string,
    signal: AbortSignal,
  ): Promise<{ readonly contentType: string }> => {
    let streaming = false;
    let contentType = "";
    try {
      await readResponse<void>(
        path,
        { method: "GET" },
        config.mediaRequestTimeoutMs,
        signal,
        async (response, requestSignal) => {
          if (!response.ok) {
            const responseBody = await response.text();
            throw new WorkerApiError(
              path,
              response.status,
              `worker API request failed (${response.status}) for ${path}: ${preview(responseBody)}`,
              errorCode(
                responseBody,
                response.headers.get("content-type") ?? "",
              ),
            );
          }
          contentType =
            (response.headers.get("content-type") ?? "")
              .split(";", 1)[0]
              ?.trim()
              .toLowerCase() ?? "";
          if (!response.body || !contentType)
            throw new WorkerApiError(
              path,
              response.status,
              `worker API returned no readable body for ${path}`,
            );
          streaming = true;
          await pipeline(
            response.body,
            createWriteStream(destinationPath, { mode: 0o600 }),
            { signal: requestSignal },
          );
          if ((await stat(destinationPath)).size === 0)
            throw new WorkerApiError(
              path,
              response.status,
              `worker API returned an empty body for ${path}`,
            );
        },
        sessionToken ?? "",
        leaseFor(jobId),
      );
    } catch (error) {
      if (streaming) await rm(destinationPath, { force: true });
      throw error;
    }
    return { contentType };
  };
  return {
    register: async () => {
      const registered = await post(
        "/v1/workers/register",
        {
          workerId: config.workerId,
          capabilities: config.capabilities,
          preflight,
        },
        RegisterResponse,
        undefined,
        config.token,
      );
      sessionToken = registered.sessionToken;
    },
    heartbeat: async () => {
      await post(
        `${prefix}/heartbeat`,
        {
          capabilities: config.capabilities,
          leases: [...leases].map(([jobId, leaseToken]) => ({
            jobId,
            leaseToken,
          })),
        },
        WorkerResponse,
      );
    },
    claim: async () => {
      const job = (await post(`${prefix}/claim`, {}, ClaimResponse)).job;
      if (job) leases.set(job.jobId, job.leaseToken);
      return job;
    },
    complete: async (jobId, result) => {
      await post(
        `${prefix}/jobs/${encodeURIComponent(jobId)}/complete`,
        { result },
        z.object({ ok: z.literal(true) }),
        undefined,
        sessionToken,
        leaseFor(jobId),
      );
      leases.delete(jobId);
    },
    fail: async (jobId, message) => {
      await post(
        `${prefix}/jobs/${encodeURIComponent(jobId)}/fail`,
        { message },
        OkResponse,
        undefined,
        sessionToken,
        leaseFor(jobId),
      );
      leases.delete(jobId);
    },
    acknowledgeCancellation: async (jobId) => {
      await post(
        `${prefix}/jobs/${encodeURIComponent(jobId)}/cancelled`,
        {},
        OkResponse,
        undefined,
        sessionToken,
        leaseFor(jobId),
      );
      leases.delete(jobId);
    },
    downloadSource: async (jobId, destinationPath, expectedSha256, signal) => {
      const path = `${prefix}/jobs/${encodeURIComponent(jobId)}/source`;
      let streaming = false;
      try {
        await readResponse<void>(
          path,
          { method: "GET" },
          config.mediaRequestTimeoutMs,
          signal,
          async (response, requestSignal) => {
            if (!response.ok) {
              const responseBody = await response.text();
              throw new WorkerApiError(
                path,
                response.status,
                `worker API request failed (${response.status}) for ${path}: ${preview(responseBody)}`,
                errorCode(
                  responseBody,
                  response.headers.get("content-type") ?? "",
                ),
              );
            }
            const contentType =
              response.headers.get("content-type")?.toLowerCase() ?? "";
            if (
              !response.body ||
              (!contentType.startsWith("video/") &&
                !contentType.includes("application/octet-stream"))
            )
              throw new WorkerApiError(
                path,
                response.status,
                `worker API returned invalid media (${contentType || "no content-type"}) for ${path}`,
              );
            streaming = true;
            const digest = createHash("sha256");
            const hashingStream = new PassThrough();
            hashingStream.on("data", (chunk: Buffer) => digest.update(chunk));
            await pipeline(
              response.body,
              hashingStream,
              createWriteStream(destinationPath, { mode: 0o600 }),
              { signal: requestSignal },
            );
            if ((await stat(destinationPath)).size === 0)
              throw new WorkerApiError(
                path,
                response.status,
                `worker API returned invalid media (${contentType}) for ${path}`,
              );
            if (digest.digest("hex") !== expectedSha256)
              throw new WorkerApiError(
                path,
                response.status,
                "WORKER_SOURCE_DIGEST_MISMATCH",
                "WORKER_SOURCE_DIGEST_MISMATCH",
              );
          },
          sessionToken ?? "",
          leaseFor(jobId),
        );
      } catch (error) {
        if (streaming) await rm(destinationPath, { force: true });
        throw error;
      }
    },
    reportProgress: async (jobId, progress, signal) => {
      await post(
        `${prefix}/jobs/${encodeURIComponent(jobId)}/progress`,
        progress,
        OkResponse,
        signal,
        sessionToken,
        leaseFor(jobId),
      );
    },
    uploadArtifact: (jobId, sourcePath, signal) =>
      upload(jobId, "artifact", sourcePath, signal),
    uploadPreview: (jobId, sourcePath, signal) =>
      upload(jobId, "preview-artifact", sourcePath, signal),
    uploadPreviewLabeled: (jobId, sourcePath, signal) =>
      upload(jobId, "preview-labeled-artifact", sourcePath, signal),
    uploadEvidenceVideo: (jobId, sourcePath, signal) =>
      upload(jobId, "evidence-video-artifact", sourcePath, signal),
    uploadSafetySample: (jobId, sourcePath, signal) =>
      upload(jobId, "safety-sample-artifact", sourcePath, signal, "image/png"),
    uploadGeneratedArtifact: (jobId, sourcePath, signal) =>
      upload(jobId, "generated-artifact", sourcePath, signal),
    downloadAttachment: (jobId, attachmentId, destinationPath, signal) =>
      downloadFile(
        `${prefix}/jobs/${encodeURIComponent(jobId)}/attachments/${encodeURIComponent(attachmentId)}`,
        jobId,
        destinationPath,
        signal,
      ),
    downloadSceneAsset: (jobId, assetId, destinationPath, signal) =>
      downloadFile(
        `${prefix}/jobs/${encodeURIComponent(jobId)}/asset-artifact/${encodeURIComponent(assetId)}`,
        jobId,
        destinationPath,
        signal,
      ),
    uploadSceneAsset: (jobId, assetId, sourcePath, contentType, signal) =>
      uploadTo(
        `${prefix}/jobs/${encodeURIComponent(jobId)}/asset-artifact/${encodeURIComponent(assetId)}`,
        jobId,
        sourcePath,
        signal,
        contentType,
      ),
    requestMaterial: async (jobId, materialRequest, signal) => {
      const response = await post(
        `${prefix}/jobs/${encodeURIComponent(jobId)}/material`,
        {
          assetId: materialRequest.assetId,
          kind: materialRequest.kind,
          prompt: materialRequest.prompt,
          seed: materialRequest.seed,
          canvas: materialRequest.canvas,
        },
        MaterialResponse,
        signal,
        sessionToken,
        leaseFor(jobId),
      );
      return {
        bytes: Buffer.from(response.bytesBase64, "base64"),
        contentType: response.contentType,
        provenance: {
          tool: response.provenance.tool,
          prompt: response.provenance.prompt,
          ...(response.provenance.seed !== undefined
            ? { seed: response.provenance.seed }
            : {}),
          sha256: response.provenance.sha256,
        },
      };
    },
  };
}
