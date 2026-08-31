import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { REGISTERED_BLENDER } from "../dist/blender-capability.js";
import { canonicalizeBlenderPng } from "../dist/self-hosted-3d-material-provider.js";

const image = `${REGISTERED_BLENDER.image}@${REGISTERED_BLENDER.imageDigest}`;
const workspace = mkdtempSync(join(tmpdir(), "rvs-blender-fixture-"));
const fixtureDirectory = resolve("scripts");

try {
  const hashes = ["fixture-1.png", "fixture-2.png"].map((output) => {
    const result = spawnSync(
      "docker",
      [
        "run",
        "--rm",
        "--network",
        "none",
        "--cpus",
        "2",
        "--memory",
        "4g",
        "--pids-limit",
        "256",
        "--read-only",
        "--tmpfs",
        "/tmp:rw,noexec,nosuid,size=512m",
        "-e",
        "HOME=/tmp",
        "--entrypoint",
        "/usr/bin/blender",
        "-v",
        `${fixtureDirectory}:/fixture:ro`,
        "-v",
        `${workspace}:/output`,
        image,
        "--background",
        "--factory-startup",
        "--disable-autoexec",
        "--python-exit-code",
        "1",
        "--python",
        "/fixture/blender-cpu-fixture.py",
        "--",
        `/output/${output}`,
      ],
      { encoding: "utf8" },
    );
    if (result.status !== 0)
      throw new Error(`BLENDER_FIXTURE_FAILED:${result.stderr.trim()}`);
    if (!result.stdout.includes(`Blender ${REGISTERED_BLENDER.version}`))
      throw new Error("BLENDER_FIXTURE_VERSION_MISMATCH");
    return createHash("sha256")
      .update(canonicalizeBlenderPng(readFileSync(join(workspace, output))))
      .digest("hex");
  });
  if (
    hashes.some((hash) => hash !== REGISTERED_BLENDER.fixtureSha256) ||
    new Set(hashes).size !== 1
  )
    throw new Error(`BLENDER_FIXTURE_DIGEST_MISMATCH:${hashes.join(",")}`);
  process.stdout.write(
    `${JSON.stringify({ image, device: "CPU", fixtureSha256: hashes[0] })}\n`,
  );
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
