// Vendored from packages/contracts/src/generation.ts — do not hand-edit.
// apps/worker is a standalone deployable (own Dockerfile/lockfile/workspace)
// and cannot depend on packages/contracts via "workspace:*" in a clean
// container build. This is a byte-for-byte copy of the pure module; the
// drift test in apps/api/src/worker-contracts-vendoring.test.ts is what
// keeps it honest -- if it fails, re-copy from packages/contracts/src.
// ---- vendored copy below, unmodified ----

import { z } from "zod";

export type Aspect = "9:16" | "1:1" | "16:9";
export const CANVAS: Record<Aspect, { readonly width: number; readonly height: number }> = {
  "9:16": { width: 1080, height: 1920 },
  "1:1": { width: 1080, height: 1080 },
  "16:9": { width: 1920, height: 1080 },
};
export const DELIVERY_FPS = 30;
export const frameCountFor = (durationSec: number): number =>
  Math.round(durationSec * DELIVERY_FPS);

export const GenerationConfigSchema = z
  .object({
    brief: z.string().min(1).max(4000),
    durationSec: z.number().int().min(15).max(30),
    aspect: z.enum(["9:16", "1:1", "16:9"]),
    attachmentIds: z.array(z.string().min(1)).max(20),
  })
  .strict();
export type GenerationConfig = z.infer<typeof GenerationConfigSchema>;
