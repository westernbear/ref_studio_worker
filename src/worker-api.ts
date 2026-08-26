import { createHash } from "node:crypto";
import { createWriteStream, openAsBlob } from "node:fs";
import { rm, stat } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
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
  const upload = async (
    jobId: string,
    kind:
      | "artifact"
      | "preview-artifact"
      | "preview-labeled-artifact"
      | "evidence-video-artifact"
      | "safety-sample-artifact",
    sourcePath: string,
    signal: AbortSignal,
    contentType: string = "video/mp4",
  ): Promise<ArtifactUpload> => {
    const path = `${prefix}/jobs/${encodeURIComponent(jobId)}/${kind}`;
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
  };
}
