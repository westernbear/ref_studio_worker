import { z } from "zod";
import type { WorkerConfig } from "./worker-config.js";

const RegisterResponse = z.object({ workerId: z.string().min(1) });
const Job = z.object({
  jobId: z.string().min(1),
  attemptId: z.string().min(1),
  payload: z.record(z.string(), z.unknown()).default({}),
});
const ClaimResponse = z.object({ job: Job.nullable() });
export type WorkerJob = z.infer<typeof Job>;
export type WorkerApi = Readonly<{
  register(): Promise<void>;
  heartbeat(): Promise<void>;
  claim(): Promise<WorkerJob | null>;
  complete(jobId: string, result: unknown): Promise<void>;
  fail(jobId: string, message: string): Promise<void>;
}>;
type Fetcher = (
  input: URL | RequestInfo,
  init?: RequestInit,
) => Promise<Response>;

export class WorkerApiError extends Error {
  readonly path: string;
  readonly status: number | null;

  constructor(path: string, status: number | null, message: string) {
    super(message);
    this.name = "WorkerApiError";
    this.path = path;
    this.status = status;
  }
}

const preview = (body: string): string =>
  body.replace(/\s+/gu, " ").trim().slice(0, 120);
const isJson = (contentType: string): boolean =>
  contentType.toLowerCase().includes("application/json");

export function createWorkerApi(
  config: WorkerConfig,
  fetcher: Fetcher = fetch,
): WorkerApi {
  async function post<T>(
    path: string,
    body: unknown,
    schema: z.ZodType<T>,
  ): Promise<T> {
    let result: Readonly<{ response: Response; responseBody: string }> | null =
      null;
    const controller = new AbortController();
    const timeout = setTimeout(
      () =>
        controller.abort(
          new Error(`request timed out after ${config.apiRequestTimeoutMs}ms`),
        ),
      config.apiRequestTimeoutMs,
    );
    try {
      const response = await fetcher(`${config.apiBaseUrl}${path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      result = { response, responseBody: await response.text() };
    } catch (error) {
      if (error instanceof Error)
        throw new WorkerApiError(
          path,
          null,
          `worker API fetch failed for ${path}; check RVS_API_BASE_URL and network reachability (${error.message})`,
        );
      throw error;
    } finally {
      clearTimeout(timeout);
    }
    if (!result)
      throw new WorkerApiError(
        path,
        null,
        `worker API fetch failed for ${path}; check RVS_API_BASE_URL and network reachability`,
      );
    const { response, responseBody } = result;
    if (!response.ok)
      throw new WorkerApiError(
        path,
        response.status,
        `worker API request failed (${response.status}) for ${path}: ${preview(responseBody)}`,
      );
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
  }
  const prefix = `/v1/workers/${encodeURIComponent(config.workerId)}`;
  return {
    register: async () => {
      await post(
        "/v1/workers/register",
        { workerId: config.workerId, capabilities: config.capabilities },
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
        z.object({ ok: z.literal(true) }),
      );
    },
  };
}
