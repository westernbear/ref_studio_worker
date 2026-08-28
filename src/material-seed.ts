import { createHash } from "node:crypto";

// Shared by every generative material provider that needs a seed to be
// reproducible (material-provider.ts's MaterialRequest doc: "a provider
// that needs a seed to be reproducible must derive one and record what it
// used" when the scene's author recorded none). Deterministic in the asset
// id and prompt alone, so retrying the very same request derives the very
// same seed, and two different assets sharing a prompt still diverge.
export const deriveMaterialSeed = (assetId: string, prompt: string): number =>
  createHash("sha256")
    .update(`${assetId} ${prompt}`)
    .digest()
    .readUInt32BE(0);
