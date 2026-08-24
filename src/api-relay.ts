import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type OutgoingHttpHeaders,
  type Server,
} from "node:http";
import { request as httpsRequest } from "node:https";
import { fileURLToPath } from "node:url";

const RELAY_PORT = 8787;
const DEFAULT_REQUEST_TIMEOUT_MS = 1_800_000;
const HEALTH_PATH = "/_relay/healthz";
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export class ApiRelayConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApiRelayConfigurationError";
  }
}

const parseUpstream = (value: string): URL => {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    if (error instanceof TypeError)
      throw new ApiRelayConfigurationError(
        "RVS_API_BASE_URL must be a valid HTTP(S) URL",
      );
    throw error;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new ApiRelayConfigurationError(
      "RVS_API_BASE_URL must use HTTP or HTTPS",
    );
  if (url.username || url.password || url.search || url.hash)
    throw new ApiRelayConfigurationError(
      "RVS_API_BASE_URL must not contain credentials, query, or fragment",
    );
  return url;
};

const forwardedHeaders = (
  headers: IncomingHttpHeaders,
  host?: string,
): OutgoingHttpHeaders => {
  const connectionHeaders = new Set(
    (headers.connection ?? "")
      .split(",")
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean),
  );
  const forwarded: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers))
    if (
      value !== undefined &&
      name !== "host" &&
      !HOP_BY_HOP_HEADERS.has(name) &&
      !connectionHeaders.has(name)
    )
      forwarded[name] = value;
  if (host !== undefined) forwarded.host = host;
  return forwarded;
};

const rejectTargetOverride = (url: string | undefined): boolean =>
  url === undefined || !url.startsWith("/") || url.startsWith("//");

export const createApiRelayServer = (
  upstreamBaseUrl: string,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
): Server => {
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1)
    throw new ApiRelayConfigurationError(
      "RVS_RELAY_REQUEST_TIMEOUT_MS must be a positive integer",
    );
  const upstream = parseUpstream(upstreamBaseUrl);
  const pathPrefix =
    upstream.pathname === "/" ? "" : upstream.pathname.replace(/\/$/u, "");
  const server = createServer((incoming, outgoing) => {
    if (incoming.method === "GET" && incoming.url === HEALTH_PATH) {
      outgoing.writeHead(204).end();
      return;
    }
    if (rejectTargetOverride(incoming.url)) {
      outgoing.writeHead(400, { "content-type": "text/plain" });
      outgoing.end("origin-form request target required");
      return;
    }

    const transport =
      upstream.protocol === "https:" ? httpsRequest : httpRequest;
    const proxied = transport(
      {
        protocol: upstream.protocol,
        hostname: upstream.hostname,
        port: upstream.port,
        method: incoming.method,
        path: `${pathPrefix}${incoming.url}`,
        headers: forwardedHeaders(incoming.headers, upstream.host),
      },
      (response) => {
        outgoing.writeHead(
          response.statusCode ?? 502,
          forwardedHeaders(response.headers),
        );
        response.on("error", (error) => outgoing.destroy(error));
        response.pipe(outgoing);
      },
    );
    proxied.on("error", (error) => {
      console.error(
        JSON.stringify({
          event: "api-relay.upstream.error",
          message: error.message,
        }),
      );
      if (outgoing.headersSent) {
        outgoing.destroy(error);
        return;
      }
      outgoing.writeHead(502, { "content-type": "text/plain" });
      outgoing.end("upstream unavailable");
    });
    const deadline = setTimeout(
      () => proxied.destroy(new Error("upstream request timed out")),
      requestTimeoutMs,
    );
    deadline.unref();
    outgoing.once("close", () => clearTimeout(deadline));
    incoming.on("aborted", () => proxied.destroy());
    incoming.pipe(proxied);
  });
  server.on("connect", (_request, socket) => {
    socket.end(
      "HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
    );
  });
  return server;
};

export const main = (env: NodeJS.ProcessEnv = process.env): void => {
  const upstream = env.RVS_API_BASE_URL;
  if (upstream === undefined)
    throw new ApiRelayConfigurationError("RVS_API_BASE_URL must be set");
  const server = createApiRelayServer(
    upstream,
    Number(
      env.RVS_RELAY_REQUEST_TIMEOUT_MS ?? String(DEFAULT_REQUEST_TIMEOUT_MS),
    ),
  );
  server.on("error", (error) => {
    console.error(
      JSON.stringify({
        event: "api-relay.server.error",
        message: error.message,
      }),
    );
    process.exitCode = 1;
  });
  server.listen(RELAY_PORT, "0.0.0.0", () => {
    console.info(
      JSON.stringify({ event: "api-relay.listening", port: RELAY_PORT }),
    );
  });
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "API relay failed to start",
    );
    process.exitCode = 1;
  }
}
