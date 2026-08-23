import { z } from "zod";
import type { WorkerConfig } from "./worker-config.js";
import type { WorkerPreflightReport } from "./worker-preflight.js";

const RegisterResponse = z.object({ workerId: z.string().min(1) });
const Job = z.object({
  jobId: z.string().min(1),
  attemptId: z.string().min(1),
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
  downloadSource(jobId: string, signal: AbortSignal): Promise<Uint8Array>;
  reportProgress(
    jobId: string,
    progress: WorkerProgress,
    signal: AbortSignal,
  ): Promise<void>;
  uploadArtifact(
    jobId: string,
    bytes: Uint8Array,
    signal: AbortSignal,
  ): Promise<ArtifactUpload>;
  uploadPreview(
    jobId: string,
    bytes: Uint8Array,
    signal: AbortSignal,
  ): Promise<ArtifactUpload>;
}>;
type Fetcher = (
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

export function createWorkerApi(
  config: WorkerConfig,
  fetcher: Fetcher = fetch,
  preflight?: WorkerPreflightReport,
): WorkerApi {
  async function readResponse<T>(
    path: string,
    init: RequestInit,
    timeoutMs: number,
    signal: AbortSignal | undefined,
    read: (response: Response) => Promise<T>,
  ): Promise<Readonly<{ response: Response; body: T }>> {
    const timeout = AbortSignal.timeout(timeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const response = await fetcher(`${config.apiBaseUrl}${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${config.token}`,
          ...init.headers,
        },
        signal: requestSignal,
      });
      return { response, body: await read(response) };
    } catch (error) {
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
      let code: string | null = null;
      if (isJson(response.headers.get("content-type") ?? ""))
        try {
          const parsed: unknown = JSON.parse(responseBody);
          const error =
            parsed !== null && typeof parsed === "object"
              ? Reflect.get(parsed, "error")
              : null;
          const value =
            error !== null && typeof error === "object"
              ? Reflect.get(error, "code")
              : null;
          code = typeof value === "string" ? value : null;
        } catch {
          code = null;
        }
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
  ): Promise<T> {
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
    );
    return parseJson(path, result.response, result.body, schema);
  }
  const prefix = `/v1/workers/${encodeURIComponent(config.workerId)}`;
  const upload = async (
    jobId: string,
    kind: "artifact" | "preview-artifact",
    bytes: Uint8Array,
    signal: AbortSignal,
  ): Promise<ArtifactUpload> => {
    const path = `${prefix}/jobs/${encodeURIComponent(jobId)}/${kind}`;
    const result = await readResponse<string>(
      path,
      {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: Uint8Array.from(bytes).buffer,
      },
      config.mediaRequestTimeoutMs,
      signal,
      (response) => response.text(),
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
      await post(
        "/v1/workers/register",
        {
          workerId: config.workerId,
          capabilities: config.capabilities,
          preflight,
        },
        RegisterResponse,
      );
    },
    heartbeat: async () => {
      await post(
        `${prefix}/heartbeat`,
        { capabilities: config.capabilities },
        RegisterResponse,
      );
    },
    claim: async () => (await post(`${prefix}/claim`, {}, ClaimResponse)).job,
    complete: async (jobId, result) => {
      await post(
        `${prefix}/jobs/${encodeURIComponent(jobId)}/complete`,
        { result },
        z.object({ ok: z.literal(true) }),
      );
    },
    fail: async (jobId, message) => {
      await post(
        `${prefix}/jobs/${encodeURIComponent(jobId)}/fail`,
        { message },
        OkResponse,
      );
    },
    acknowledgeCancellation: async (jobId) => {
      await post(
        `${prefix}/jobs/${encodeURIComponent(jobId)}/cancelled`,
        {},
        OkResponse,
      );
    },
    downloadSource: async (jobId, signal) => {
      const path = `${prefix}/jobs/${encodeURIComponent(jobId)}/source`;
      const result = await readResponse<Uint8Array>(
        path,
        { method: "GET" },
        config.mediaRequestTimeoutMs,
        signal,
        async (response) => new Uint8Array(await response.arrayBuffer()),
      );
      if (!result.response.ok)
        throw new WorkerApiError(
          path,
          result.response.status,
          `worker API request failed (${result.response.status}) for ${path}: ${preview(new TextDecoder().decode(result.body))}`,
        );
      const contentType =
        result.response.headers.get("content-type")?.toLowerCase() ?? "";
      if (
        result.body.byteLength === 0 ||
        (!contentType.startsWith("video/") &&
          !contentType.includes("application/octet-stream"))
      )
        throw new WorkerApiError(
          path,
          result.response.status,
          `worker API returned invalid media (${contentType || "no content-type"}) for ${path}`,
        );
      return result.body;
    },
    reportProgress: async (jobId, progress, signal) => {
      await post(
        `${prefix}/jobs/${encodeURIComponent(jobId)}/progress`,
        progress,
        OkResponse,
        signal,
      );
    },
    uploadArtifact: (jobId, bytes, signal) =>
      upload(jobId, "artifact", bytes, signal),
    uploadPreview: (jobId, bytes, signal) =>
      upload(jobId, "preview-artifact", bytes, signal),
  };
}
