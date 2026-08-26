import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runCommand, type CommandRunner } from "../process-runner.js";
import type { EvidenceTrack } from "./tracks.js";

const COLOR_BY_KIND: Readonly<Record<EvidenceTrack["kind"], string>> = {
  bbox: "yellow",
  trajectory: "cyan",
  "ocr-text": "lime",
  effect: "magenta",
  "audio-anchor": "orange",
};

const escapeDrawtext = (value: string): string =>
  value.replaceAll("\\", "\\\\").replaceAll(":", "\\:").replaceAll("'", "\\'");

const frameWindow = (frame: number, fps: number): readonly [number, number] => [
  frame / fps,
  (frame + 1) / fps,
];

// ponytail: one drawbox/drawtext clause per frame per track keeps the
// string generation simple and testable without a timed-command script.
// A real 120-frame/multi-track clip already produces a filter string past
// the OS argv limit (spawn() throws E2BIG) -- renderEvidenceVideo writes
// this to a file and passes it via `-/filter:v` instead of `-vf <string>`,
// so the string's length here is no longer bounded by argv at all.
export const buildEvidenceOverlayFilter = (
  tracks: readonly EvidenceTrack[],
  options: Readonly<{ fps: number }>,
): string => {
  const clauses: string[] = [];
  for (const track of tracks) {
    const color = COLOR_BY_KIND[track.kind];
    for (const point of track.frames) {
      const [start, end] = frameWindow(point.frame, options.fps);
      const enable = `enable='between(t\\,${start.toFixed(3)}\\,${end.toFixed(3)})'`;
      if (track.kind === "bbox" && point.bounds) {
        const [x, y, w, h] = point.bounds;
        clauses.push(
          `drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=${color}@0.8:thickness=3:${enable}`,
        );
        clauses.push(
          `drawtext=text='${escapeDrawtext(track.label)}':x=${x}:y=${Math.max(0, y - 24)}:fontsize=20:fontcolor=${color}:box=1:boxcolor=black@0.5:${enable}`,
        );
      } else if (track.kind === "trajectory" && point.point) {
        const [x, y] = point.point;
        clauses.push(
          `drawbox=x=${x - 3}:y=${y - 3}:w=6:h=6:color=${color}@0.9:thickness=fill:${enable}`,
        );
      } else if (track.kind === "ocr-text" && point.bounds) {
        const [x, y, w, h] = point.bounds;
        clauses.push(
          `drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=${color}@0.6:thickness=2:${enable}`,
        );
      } else if (track.kind === "effect" && point.bounds) {
        const [x, y] = point.bounds;
        clauses.push(
          `drawtext=text='${escapeDrawtext(track.label)}':x=${x}:y=${y}:fontsize=16:fontcolor=${color}:${enable}`,
        );
      } else if (track.kind === "audio-anchor") {
        clauses.push(
          `drawbox=x=0:y=ih-12:w=iw:h=12:color=${color}@0.7:thickness=fill:${enable}`,
        );
      }
    }
  }
  return clauses.join(",");
};

export type RenderEvidenceVideoInput = Readonly<{
  normalizedPath: string;
  outputPath: string;
  workspace: string;
  tracks: readonly EvidenceTrack[];
  fps: number;
  signal: AbortSignal;
}>;

export const renderEvidenceVideo = async (
  input: RenderEvidenceVideoInput,
  command: CommandRunner = runCommand,
): Promise<void> => {
  const filter = buildEvidenceOverlayFilter(input.tracks, { fps: input.fps });
  const filterArgs: string[] = [];
  if (filter.length > 0) {
    const filterPath = join(input.workspace, "evidence-overlay-filter.txt");
    await writeFile(filterPath, filter, "utf8");
    // -filter_script:v (not the newer -/filter:v) -- production runs
    // ffmpeg 5.1.9, which predates the -/filter generic file-read syntax.
    // -filter_script:v has worked since ffmpeg 2.x and still works on 8.x
    // (deprecated but functional), so it's the compatible choice here.
    filterArgs.push("-filter_script:v", filterPath);
  }
  await command(
    process.env.RVS_FFMPEG_PATH ?? "ffmpeg",
    [
      "-nostdin",
      "-y",
      "-i",
      input.normalizedPath,
      ...filterArgs,
      // normalizedPath is pcm_s16le in an mkv container; the mp4 muxer
      // rejects raw PCM, so the audio must be transcoded, not copied.
      "-c:a",
      "aac",
      input.outputPath,
    ],
    { cwd: input.workspace, signal: input.signal },
  );
};
