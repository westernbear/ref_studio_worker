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
      "--mode=go=rX,u+rwX",
      "-cf",
      outputPath,
      "-C",
      packageDirectory,
      ".",
    ],
    { cwd: packageDirectory, signal },
  );
}
