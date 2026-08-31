import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildVfxLabelFilter, renderVfxLabelVideo } from "./vfx-labels.js";
import type { CommandRunner } from "../process-runner.js";

describe("buildVfxLabelFilter", () => {
  it("captions only the treatments the scene actually applies", () => {
    const filter = buildVfxLabelFilter(["owner-bloom-defocus"]);
    expect(filter).toContain("OWNER BLOOM + DEFOCUS");
    expect(filter).not.toContain("NON-UNIFORM RIM");
  });

  it("stamps the frame number without a clause per frame", () => {
    const filter = buildVfxLabelFilter([]);
    expect(filter).toContain("F%{frame_num}");
    expect(filter).toContain("fontfile='/opt/rvs/fonts/WantedSansVariable.ttf'");
    expect(filter.split("drawtext").length - 1).toBe(1);
  });

  it("orders captions consistently regardless of pass order", () => {
    const forward = buildVfxLabelFilter([
      "owner-bloom-defocus",
      "lower-light-field-13tap",
    ]);
    const reversed = buildVfxLabelFilter([
      "lower-light-field-13tap",
      "owner-bloom-defocus",
    ]);
    expect(forward).toBe(reversed);
  });
});

describe("renderVfxLabelVideo", () => {
  let workspace = "";
  afterEach(async () => {
    if (workspace) await rm(workspace, { recursive: true, force: true });
    workspace = "";
  });

  it("passes the captions through a filter file, never argv", async () => {
    workspace = await mkdtemp(join(tmpdir(), "rvs-vfx-labels-test-"));
    const calls: Array<readonly string[]> = [];
    const command: CommandRunner = async (_cmd, args) => {
      calls.push(args);
      return { stdout: "", stderr: "" };
    };
    await renderVfxLabelVideo(
      {
        previewPath: join(workspace, "preview.mp4"),
        outputPath: join(workspace, "preview-labeled.mp4"),
        workspace,
        shaders: ["owner-bloom-defocus"],
        signal: new AbortController().signal,
      },
      command,
    );
    expect(calls[0]).toContain("-filter_script:v");
    expect(calls[0]).not.toContain("-vf");
    expect(calls[0]).toContain(join(workspace, "vfx-label-filter.txt"));
  });
});
