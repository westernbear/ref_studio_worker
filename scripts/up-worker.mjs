// Brings up the worker daemon and the api-relay it talks through, locally
// or on a remote GPU host.
//
//   node scripts/up-worker.mjs
//   node scripts/up-worker.mjs --no-gpu
//   node scripts/up-worker.mjs --host operator@gpu-box
//   node scripts/up-worker.mjs --no-build
//
// The relay comes up with it and is not optional: worker sits on
// worker-internal, which is internal:true, so the relay is its only route
// to the API server.
//
// ponytail: the worker's own torch is CPU-only (compiler/pyproject.toml)
// and the renderer is SwiftShader, so the GPU overlay does not make the
// worker faster -- it makes the device visible to it, which is what a host
// running the generators alongside usually wants. The generators are the
// parts that actually need the card; see scripts/up-generators.mjs.
import { assert, compose, parseArgs, report, waitFor } from "./common.mjs";

const SERVICES = ["api-relay", "worker"];

const args = parseArgs(process.argv.slice(2));
const host = typeof args.host === "string" ? args.host : null;
const gpu = !args["no-gpu"];

// Both are required by src/worker-config.ts and neither has a default. A
// container that starts without them exits on its first tick, which is a
// worse place to read the error than here.
for (const name of ["RVS_API_BASE_URL", "RVS_WORKER_TOKEN"])
  assert(Boolean(process.env[name]), "WORKER_ENV_MISSING");

const prefix = [
  "--file=docker-compose.yml",
  ...(gpu ? ["--file=docker-compose.gpu.yml"] : []),
];
await compose(
  [
    ...prefix,
    "up",
    "-d",
    ...(args["no-build"] ? [] : ["--build"]),
    ...SERVICES,
  ],
  host,
);

// The relay has its own healthcheck and the worker waits on it, so once
// both are running the chain to the API server is already proven.
const rows = await waitFor(
  prefix,
  SERVICES,
  host,
  (row) => row.State === "running",
  300_000,
  "WORKER_NOT_RUNNING",
);

report({
  status: "worker-up-pass",
  host,
  gpu,
  services: SERVICES.map((service) => ({
    service,
    state: rows.find((row) => row.Service === service)?.State ?? null,
  })),
});
