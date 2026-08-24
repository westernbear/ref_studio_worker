import { once } from "node:events";
import {
  createServer,
  request,
  type IncomingHttpHeaders,
  type Server,
} from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiRelayServer } from "./api-relay.js";

type Response = Readonly<{
  status: number | undefined;
  headers: IncomingHttpHeaders;
  body: string;
}>;

const servers: Server[] = [];

const listen = async (server: Server): Promise<number> => {
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new TypeError("expected an IP listener");
  return address.port;
};

const send = (
  port: number,
  options: Readonly<{
    method: string;
    path: string;
    headers?: Readonly<Record<string, string>>;
    body?: string;
  }>,
): Promise<Response> =>
  new Promise((resolve, reject) => {
    const outgoing = request(
      {
        hostname: "127.0.0.1",
        port,
        method: options.method,
        path: options.path,
        headers: options.headers,
      },
      (incoming) => {
        let body = "";
        incoming.setEncoding("utf8");
        incoming.on("data", (chunk: string) => {
          body += chunk;
        });
        incoming.on("end", () =>
          resolve({
            status: incoming.statusCode,
            headers: incoming.headers,
            body,
          }),
        );
      },
    );
    outgoing.on("error", reject);
    outgoing.end(options.body);
  });

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
});

describe("API relay", () => {
  it("forwards requests only to its configured upstream", async () => {
    let forwarded: unknown;
    let arbitraryTargetRequests = 0;
    const upstreamPort = await listen(
      createServer((incoming, outgoing) => {
        let body = "";
        incoming.setEncoding("utf8");
        incoming.on("data", (chunk: string) => {
          body += chunk;
        });
        incoming.on("end", () => {
          forwarded = {
            method: incoming.method,
            path: incoming.url,
            authorization: incoming.headers.authorization,
            lease: incoming.headers["x-worker-lease"],
            body,
          };
          outgoing.writeHead(202, {
            "content-type": "text/plain",
            "x-upstream": "fixed",
          });
          outgoing.end("accepted");
        });
      }),
    );
    const arbitraryTargetPort = await listen(
      createServer((_incoming, outgoing) => {
        arbitraryTargetRequests += 1;
        outgoing.end("unsafe");
      }),
    );
    const relayPort = await listen(
      createApiRelayServer(`http://127.0.0.1:${upstreamPort}/api`),
    );

    const response = await send(relayPort, {
      method: "POST",
      path: "/v1/jobs/job-a/artifact?part=2",
      headers: {
        authorization: "Bearer worker-session",
        "content-type": "application/octet-stream",
        "x-worker-lease": "lease-a",
      },
      body: "artifact-bytes",
    });
    const confined = await send(relayPort, {
      method: "GET",
      path: `http://127.0.0.1:${arbitraryTargetPort}/escaped`,
    });

    expect(response).toMatchObject({
      status: 202,
      headers: { "x-upstream": "fixed" },
      body: "accepted",
    });
    expect(forwarded).toEqual({
      method: "POST",
      path: "/api/v1/jobs/job-a/artifact?part=2",
      authorization: "Bearer worker-session",
      lease: "lease-a",
      body: "artifact-bytes",
    });
    expect(confined.status).toBe(400);
    expect(arbitraryTargetRequests).toBe(0);
  });

  it("times out an upstream request at the configured deadline", async () => {
    const upstreamPort = await listen(
      createServer((_incoming, outgoing) => {
        setTimeout(() => outgoing.end("late"), 80);
      }),
    );
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const relayPort = await listen(
        createApiRelayServer(`http://127.0.0.1:${upstreamPort}`, 20),
      );

      await expect(
        send(relayPort, { method: "GET", path: "/slow" }),
      ).resolves.toMatchObject({ status: 502, body: "upstream unavailable" });
    } finally {
      errorSpy.mockRestore();
    }
  });
});
