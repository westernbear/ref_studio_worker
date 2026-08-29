import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCommand } from "./process-runner.js";
import { archiveScenePackage } from "./scene-package-archive.js";

describe("archiveScenePackage", () => {
  it("creates byte-identical archives for identical packages", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "rvs-package-archive-"));
    try {
      const directory = join(workspace, "package");
      await mkdir(directory);
      await writeFile(join(directory, "scene.json"), "{}\n");
      const signal = new AbortController().signal;
      const first = join(workspace, "first.tar");
      const second = join(workspace, "second.tar");
      await archiveScenePackage(directory, first, signal, runCommand);
      await archiveScenePackage(directory, second, signal, runCommand);
      const hash = (bytes: Uint8Array): string =>
        createHash("sha256").update(bytes).digest("hex");
      expect(hash(await readFile(first))).toBe(hash(await readFile(second)));
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
