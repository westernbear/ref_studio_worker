// Worker-local copy of the contracts values this image actually enforces.
// resource-budgets is not one of the six vendored modules; keep this file
// inside apps/worker rather than adding a seventh vendored contracts file.
export const RESOURCE_BUDGETS = {
  maxFfmpegOutputBytes: 2 * 1024 * 1024 * 1024,
  maxBlenderTriangles: 250_000,
} as const;

export type Blender3dBudget = Readonly<{
  maxTriangles: number;
  maxMaterials: number;
  maxTextureDimension: number;
  maxTextures: number;
  maxBytes: number;
}>;

export const BLENDER_3D_BUDGET: Blender3dBudget = {
  maxTriangles: RESOURCE_BUDGETS.maxBlenderTriangles,
  maxMaterials: 64,
  maxTextureDimension: 4096,
  maxTextures: 32,
  maxBytes: 64 * 1024 * 1024,
};
