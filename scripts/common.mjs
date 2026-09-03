import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { parseArgs as parseNodeArgs } from "node:util";

export const root = resolve(import.meta.dirname, "..");

export function parseArgs(argv) {
  const { values } = parseNodeArgs({
    args: argv,
    options: {
      host: { type: "string" },
      models: { type: "string" },
      only: { type: "string" },
      "no-gpu": { type: "boolean" },
      "no-build": { type: "boolean" },
    },
    strict: true,
    allowPositionals: false,
  });
  return values;
}

export function assert(condition, token) {
  if (!condition) throw new Error(token);
}

// Remote is the same code path as local with one variable changed. Docker's
// own ssh:// transport puts the build context and the containers on the
// other host; there is no registry to push to and no second script to keep
// in step with this one.
const environment = (host) =>
  host ? { ...process.env, DOCKER_HOST: `ssh://${host}` } : process.env;

const run = (args, host, capture) =>
  new Promise((resolvePromise, reject) => {
    const child = spawn("docker", ["compose", ...args], {
      cwd: root,
      env: environment(host),
      stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
    });
    let output = "";
    if (capture) child.stdout.on("data", (chunk) => (output += chunk));
    child.on("error", () => reject(new Error("DOCKER_NOT_AVAILABLE")));
    child.on("close", (code) =>
      code === 0
        ? resolvePromise(output)
        : reject(new Error(`DOCKER_COMPOSE_FAILED_${code}`)),
    );
  });

export const compose = (args, host) => run(args, host, false);

// `docker compose ps --format json` emits one object per line on current
// Docker and a single array on older ones. Both are read, because the
// operator's Docker version is not this script's to choose.
export const composePs = async (args, host) => {
  const [flags, services] = [
    args.filter((arg) => arg.startsWith("-") || arg.startsWith("--")),
    args.filter((arg) => !arg.startsWith("-")),
  ];
  const output = (
    await run([...flags, "ps", "--all", "--format", "json", ...services], host)
  ).trim();
  if (!output) return [];
  if (output.startsWith("[")) return JSON.parse(output);
  return output.split("\n").map((line) => JSON.parse(line));
};

// `prefix` carries the same --profile / -f flags the `up` used: a service
// behind a profile is invisible to `ps` without them.
export const waitFor = async (
  prefix,
  services,
  host,
  predicate,
  timeoutMs,
  token,
) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await composePs([...prefix, ...services], host);
    const matched = services.filter((service) =>
      rows.some((row) => row.Service === service && predicate(row)),
    );
    if (matched.length === services.length) return rows;
    if (Date.now() > deadline) throw new Error(token);
    await new Promise((done) => setTimeout(done, 5_000));
  }
};

export const report = (payload) =>
  process.stdout.write(JSON.stringify(payload) + "\n");
