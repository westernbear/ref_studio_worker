# Self-hosted generators

Two services the worker calls directly for material it cannot get any other
way: Wan-Alpha for video with a real alpha channel, Hi3DGen for meshes that
the worker then renders as object-form images.

Both sit on `worker-internal`, which is `internal: true`. They have no route
off the host. That is the point — generated material never leaves the
machine and the worker still has no internet — and it has one consequence
worth stating up front: **weights cannot be downloaded at runtime.** Put
them on the host and mount them.

## Bringing one up

```sh
# from the worker checkout
docker compose --profile video   up -d --build wan-alpha
docker compose --profile model3d up -d --build hi3dgen
```

Neither starts without its profile, so an ordinary `docker compose up`
brings up the worker alone and leaves the GPU services out.

Then set the address in the admin console under **Material generators**:
`http://wan-alpha:8000` and `http://hi3dgen:8000`. The API sends it to the
worker with each assets claim, read fresh per claim, so a change takes
effect on the next job rather than the next restart. Leave one blank and
that material kind is refused by name — a scene that asks for neither video
nor object material is unaffected.

## One at a time

This is not a suggestion on a single card.

| | VRAM | Note |
|---|---|---|
| Wan-Alpha (Wan2.1-14B, GGUF Q4_K_M) | ~10 GB before its text encoder | |
| Hi3DGen | 6–8 GB with staged CPU offload | Plus the text-to-image stage |

A 12 GB card fits one. Both want 32 GB of system RAM or more, because
offload goes there. Switching between them should be a container restart,
not an in-process unload: PyTorch does not reliably return reserved memory
to the operating system.

## Weights

Mount a host directory at `/models` by setting `RVS_MODEL_CACHE`; the
default is `./generators/models`, which is git-ignored.

```
models/
  wan2.1-14b-Q4_K_M.gguf     RVS_WAN_BASE
  wan-alpha-dora/            RVS_WAN_DORA
  wan-alpha-vae-rgb/         RVS_WAN_VAE_RGB
  wan-alpha-vae-alpha/       RVS_WAN_VAE_ALPHA
  hi3dgen/                   RVS_HI3DGEN_WEIGHTS
  sdxl-turbo/                RVS_HI3DGEN_T2I
```

## What is unverified

This repository has no GPU and no copy of the weights, so none of the model
loading or generation below has been run. The HTTP contract, the stacking
convention, the encoding, and the failure names are exercised by the
worker's own tests; the model calls are written against the documented APIs
of diffusers and the two upstream releases. Expect to correct them on the
first real run — every failure is named rather than swallowed, so a first
run says which step was wrong.

Specifically:

**Wan-Alpha over a quantised base is unverified by anyone publicly.** Its
RGBA output needs a DoRA and two custom VAE decoders on top of Wan2.1-14B,
and no report exists of that combination working over a GGUF-quantised
base. The fp8 base is the lower-risk route and does not fit 12 GB. Quality
loss at Q4 has only been assessed on RGB, never on alpha edges — hair,
glow, semi-transparency — which is what this model exists for. **Test the
matte before relying on it.**

**Hi3DGen is image-to-3D and the worker sends only a prompt.** This service
closes that gap by drawing a reference image first (`RVS_HI3DGEN_T2I`) and
lifting that. It is a workaround, not the right answer: the right answer is
for the scene to supply a reference image, which SpecAsset has no field for
today. Until then the mesh is only ever as good as an image the scene never
saw.

**Hi3DGen leaks VRAM between generations.** Stable3DGen issue #42 reports
14.2 GB growing to 23.9 GB over three runs. The server frees outputs and
empties the CUDA cache after every request; `RVS_HI3DGEN_EMPTY_CACHE=0`
turns that off, which is only useful while investigating it.

## Determinism

The seed the worker sends is the seed used, so the same prompt and seed
should give the same output. That is a weaker guarantee than the renderer's:
diffusion on a GPU is not bit-reproducible across driver versions. It does
not need to be. Generated material is pinned as an artifact and hashed
once, and every render afterwards draws those exact bytes — which is why
the frame-hash claim survives a non-deterministic generator.
