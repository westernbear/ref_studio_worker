// Brings up every self-hosted generator this worker can talk to -- hi3dgen
// (object-form 3D) and wan-alpha (video) -- in Docker, locally or on a
// remote GPU host.
//
//   node scripts/up-generators.mjs
//   node scripts/up-generators.mjs --models /srv/models
//   node scripts/up-generators.mjs --only model3d
//   node scripts/up-generators.mjs --host operator@gpu-box
//   node scripts/up-generators.mjs --no-build
//
// The 2D image generator is not here: it is a hosted API the API server
// calls with its own credential, not a container.
//
// One caveat the compose file states and this script cannot enforce: a 14B
// video model at Q4 is ~10GB of a 12GB card before its text encoder, so on
// a single 12GB GPU these two cannot co-reside. Use --only, or give them a
// GPU each.
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  assert,
  compose,
  parseArgs,
  report,
  root,
  waitFor,
} from "./common.mjs";

const GENERATORS = {
  model3d: "hi3dgen",
  video: "wan-alpha",
};

const args = parseArgs(process.argv.slice(2));
const host = typeof args.host === "string" ? args.host : null;
const only = typeof args.only === "string" ? args.only : null;
assert(!only || only in GENERATORS, "UNKNOWN_GENERATOR_PROFILE");

const profiles = only ? [only] : Object.keys(GENERATORS);
const services = profiles.map((profile) => GENERATORS[profile]);

// Weights are mounted, never downloaded: worker-internal is internal:true,
// so a container that started without them has no way to fetch them and
// would fail at the first request instead of here.
if (typeof args.models === "string") process.env.RVS_MODEL_CACHE = args.models;
const models = process.env.RVS_MODEL_CACHE ?? "./generators/models";
assert(
  host !== null || existsSync(resolve(root, models)),
  "MODEL_CACHE_MISSING",
);

const prefix = profiles.map((profile) => `--profile=${profile}`);
await compose(
  [
    ...prefix,
    "up",
    "-d",
    ...(args["no-build"] ? [] : ["--build"]),
    ...services,
  ],
  host,
);

// Loading a 14B model off disk is minutes: the compose healthcheck's own
// start_period is 600s, so the budget here has to be longer than that or it
// would call a service that is doing exactly what it was told to unhealthy.
const rows = await waitFor(
  prefix,
  services,
  host,
  (row) => row.Health === "healthy",
  900_000,
  "GENERATOR_UNHEALTHY",
);

report({
  status: "generators-up-pass",
  host,
  models,
  services: services.map((service) => ({
    service,
    state: rows.find((row) => row.Service === service)?.State ?? null,
  })),
});
