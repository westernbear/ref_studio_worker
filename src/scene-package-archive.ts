import { dirname } from "node:path";
import type { CommandRunner } from "./process-runner.js";

export async function archiveScenePackage(
  packageDirectory: string,
  outputPath: string,
  signal: AbortSignal,
  run: CommandRunner,
): Promise<void> {
  await run(
    process.env.RVS_TAR_PATH ?? "tar",
    [
      "--sort=name",
      "--mtime=@0",
      "--owner=0",
      "--group=0",
      "--numeric-owner",
      "--format=ustar",
      "-cf",
      outputPath,
      "-C",
      dirname(packageDirectory),
      packageDirectory.slice(dirname(packageDirectory).length + 1),
    ],
    { cwd: dirname(packageDirectory), signal },
  );
}
