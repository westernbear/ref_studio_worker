import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runCommand, type CommandRunner } from "../process-runner.js";
import { escapeDrawtext } from "./drawtext.js";
import type { EvidenceTrack } from "./tracks.js";

const COLOR_BY_KIND: Readonly<Record<EvidenceTrack["kind"], string>> = {
  bbox: "yellow",
  trajectory: "cyan",
  "ocr-text": "lime",
  effect: "magenta",
  "audio-anchor": "orange",
};

// Frame-indexed, not time-windowed. between(t, f/fps, (f+1)/fps) is inclusive
// at both ends and adjacent windows share an endpoint, so with PTS quantised
// to the millisecond every overlay was painted on its own frame AND the next
// one -- on a moving subject, two boxes in two places on every frame of the
// artifact whose whole job is per-frame evidence.
const enableAtFrame = (frame: number): string => `enable='eq(n\\,${frame})'`;

// ponytail: one drawbox/drawtext clause per frame per track keeps the string
// generation simple and testable without a timed-command script. Writing the
// filter to a file lifted the old argv/E2BIG ceiling, but the next one is
// ffmpeg's own graph construction, which is roughly quadratic: measured on the
// production 5.1.9 build, 3.6k clauses take 43s, 7.2k take 159s, and 31k --
// reachable from the compiler's own caps of 26 owners x 240 frames -- had
// emitted no frame at all after 37 minutes, past runCommand's 30-minute
// deadline. Hence the budget below; raising it means measuring again.
const MAX_OVERLAY_CLAUSES = 4_000;

// A name sits above its box, and drops inside it when there is no room above.
// Both decisions are about the frame, not the box: the content-window box
// begins *above* the frame on a pillarboxed source -- inverting the letterbox
// fit puts its top near -24 -- so measuring room from the box's own y put its
// name back within a couple of pixels of the top edge, where a card's name
// already was. Measure from where the box actually starts being visible.
const nameLabelY = (y: number): number => {
  const visibleTop = Math.max(0, y);
  return visibleTop >= 24 ? visibleTop - 24 : visibleTop + 26;
};

export const buildEvidenceOverlayFilter = (
  tracks: readonly EvidenceTrack[],
  _options: Readonly<{ fps: number }> = { fps: 30 },
): string => {
  const clauses: string[] = [];
  // Densest tracks cost the most and say the least, so drop from that end and
  // say so -- a silent truncation reads as "we drew everything".
  const ordered = [...tracks].sort(
    (left, right) => left.frames.length - right.frames.length,
  );
  const drawn: EvidenceTrack[] = [];
  let budget = MAX_OVERLAY_CLAUSES;
  for (const track of ordered) {
    const cost = track.frames.length * (track.kind === "bbox" ? 2 : 1);
    if (cost > budget) continue;
    budget -= cost;
    drawn.push(track);
  }
  if (drawn.length < tracks.length)
    console.info(
      JSON.stringify({
        event: "worker.evidence.overlay.truncated",
        tracksDrawn: drawn.length,
        tracksTotal: tracks.length,
        maxClauses: MAX_OVERLAY_CLAUSES,
      }),
    );
  for (const track of drawn) {
    const color = COLOR_BY_KIND[track.kind];
    for (const point of track.frames) {
      const enable = enableAtFrame(point.frame);
      if (track.kind === "bbox" && point.bounds) {
        const [x, y, w, h] = point.bounds;
        clauses.push(
          `drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=${color}@0.8:thickness=3:${enable}`,
        );
        clauses.push(
          `drawtext=text='${escapeDrawtext(track.label)}':x=${x}:y=${nameLabelY(y)}:fontsize=20:fontcolor=${color}:box=1:boxcolor=black@0.5:${enable}`,
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
          `drawtext=text='${escapeDrawtext(track.label)}':x=${x}:y=${y + 4}:fontsize=16:fontcolor=${color}:${enable}`,
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
      // The input is the ffv1 yuv444p10le master, and x264 follows its input
      // unless told otherwise: unpinned, this produced High 4:4:4 Predictive
      // (and 10-bit whenever there were no overlay clauses to force 8-bit).
      // No hardware decoder handles 4:4:4, so the artifact would not play in
      // Safari or on iOS. Pin what the delivery path already pins.
      "-c:v",
      "libx264",
      "-profile:v",
      "high",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      // normalizedPath is pcm_s16le in an mkv container; the mp4 muxer
      // rejects raw PCM, so the audio must be transcoded, not copied.
      "-c:a",
      "aac",
      input.outputPath,
    ],
    { cwd: input.workspace, signal: input.signal },
  );
};
