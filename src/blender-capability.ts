import { z } from "zod";
import {
  BLENDER_3D_BUDGET,
  type Blender3dBudget,
} from "./blender-glb-contract.js";

export const REGISTERED_BLENDER = {
  image: "docker.io/blender:4.3.3",
  imageDigest:
    "sha256:2ddf36d74847e243fc07e06979e5fb1d8c2d2bc39d23b7a883ccc106f35d8a63",
  version: "4.3.3",
  device: "CPU",
  fixtureSha256:
    "1d4725fdc2555df8f53735af6b28787f30423a2429b31d17a090ec4fe83bd72a",
  budget: BLENDER_3D_BUDGET,
} as const;

const CapabilitySchema = z
  .object({
    imageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    version: z.string(),
    device: z.literal("CPU"),
    fixtureSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    fixturePassed: z.literal(true),
    budget: z
      .object({
        maxTriangles: z.number().int().positive(),
        maxMaterials: z.number().int().positive(),
        maxTextureDimension: z.number().int().positive(),
        maxTextures: z.number().int().positive(),
        maxBytes: z.number().int().positive(),
      })
      .strict(),
  })
  .strict();

export type BlenderCapabilitySnapshot = Readonly<{
  imageDigest: string;
  version: string;
  device: "CPU";
  fixtureSha256: string;
  fixturePassed: true;
  budget: Blender3dBudget;
}>;

export class BlenderCapabilityError extends Error {
  constructor(detail: string) {
    super(`BLENDER_CAPABILITY_UNAVAILABLE:${detail}`);
    this.name = "BlenderCapabilityError";
  }
}

export const parseBlenderCapability = (
  value: unknown,
): BlenderCapabilitySnapshot => {
  const result = CapabilitySchema.safeParse(value);
  if (!result.success) throw new BlenderCapabilityError("snapshot");
  const snapshot = result.data;
  if (
    snapshot.imageDigest !== REGISTERED_BLENDER.imageDigest ||
    snapshot.version !== REGISTERED_BLENDER.version ||
    snapshot.fixtureSha256 !== REGISTERED_BLENDER.fixtureSha256 ||
    JSON.stringify(snapshot.budget) !==
      JSON.stringify(REGISTERED_BLENDER.budget)
  )
    throw new BlenderCapabilityError("identity");
  return snapshot;
};

export function parseBlenderCapabilityEnv(
  value: string,
): BlenderCapabilitySnapshot;
export function parseBlenderCapabilityEnv(value: undefined): undefined;
export function parseBlenderCapabilityEnv(
  value: string | undefined,
): BlenderCapabilitySnapshot | undefined {
  if (value === undefined) return undefined;
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch (error) {
    if (error instanceof SyntaxError) throw new BlenderCapabilityError("json");
    throw error;
  }
  return parseBlenderCapability(decoded);
}
