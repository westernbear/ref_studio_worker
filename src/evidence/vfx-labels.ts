import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { runCommand, type CommandRunner } from "../process-runner.js";
import { escapeDrawtext } from "./drawtext.js";

// The reviewer has to be able to tell which treatments the animatic is
// actually applying, so each shader present in the scene gets a standing
// caption alongside a running frame stamp.
const LABEL_BY_SHADER: Readonly<Record<string, string>> = {
  "owner-bloom-defocus": "OWNER BLOOM + DEFOCUS",
  "dynamic-nonuniform-rim": "ENHANCED MOVING NON-UNIFORM RIM",
  "lower-light-field-13tap": "CONTINUOUS LOWER BLUE BLOOM + TREATMENT",
};
const LABEL_ORDER = [
  "owner-bloom-defocus",
  "dynamic-nonuniform-rim",
  "lower-light-field-13tap",
] as const;

// ponytail: captions are fixed-position stamps, not anchored to each owner.
// That is what the reviewer gate asks for, and it keeps this to one cheap
// ffmpeg pass over the finished animatic instead of a second full Chromium
// capture. Anchoring a caption per owner means going back to the renderer.
export const buildVfxLabelFilter = (
  shaders: readonly string[],
): string => {
  const present = LABEL_ORDER.filter((shader) => shaders.includes(shader));
  const clauses = present.map((shader, row) => {
    const text = escapeDrawtext(LABEL_BY_SHADER[shader] ?? shader);
    return `drawtext=text='${text}':x=32:y=${32 + row * 44}:fontsize=26:fontcolor=white:box=1:boxcolor=black@0.55:boxborderw=10`;
  });
  // %{frame_num} is expanded by drawtext itself, so the running stamp costs
  // one clause rather than one per frame.
  clauses.push(
    "drawtext=text='F%{frame_num}':x=32:y=h-58:fontsize=26:fontcolor=white:box=1:boxcolor=black@0.55:boxborderw=10",
  );
  return clauses.join(",");
};

export type RenderVfxLabelVideoInput = Readonly<{
  previewPath: string;
  outputPath: string;
  workspace: string;
  shaders: readonly string[];
  signal: AbortSignal;
}>;

export const renderVfxLabelVideo = async (
  input: RenderVfxLabelVideoInput,
  command: CommandRunner = runCommand,
): Promise<void> => {
  const filter = buildVfxLabelFilter(input.shaders);
  const filterPath = join(input.workspace, "vfx-label-filter.txt");
  await writeFile(filterPath, filter, "utf8");
  await command(
    process.env.RVS_FFMPEG_PATH ?? "ffmpeg",
    [
      "-nostdin",
      "-y",
      "-i",
      input.previewPath,
      // -filter_script:v, not -/filter:v -- production runs ffmpeg 5.1.9.
      "-filter_script:v",
      filterPath,
      "-c:a",
      "copy",
      input.outputPath,
    ],
    { cwd: input.workspace, signal: input.signal },
  );
};
