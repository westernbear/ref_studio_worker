"""Hi3DGen behind the one HTTP contract the worker already speaks.

The worker calls ``POST /v1/generate`` with ``{"prompt": ..., "seed": ...}``
and expects raw glTF-binary (.glb) bytes back -- see
``apps/worker/src/self-hosted-3d-material-provider.ts``, which is the only
client this service will ever have. Hi3DGen produces geometry only, no
texture; giving the mesh a material, lighting it, and rendering one still
is the worker's job, with a pinned CPU-only Cycles setup.

**Hi3DGen is image-to-3D, and the worker sends only text.** That gap is
real and this service is where it has to be closed: the prompt is drawn
first, then the image is lifted into a mesh. The text-to-image stage is
therefore not an optional extra here -- without it there is nothing to lift
-- so an unset or missing ``RVS_HI3DGEN_T2I`` fails by name rather than
returning a mesh of something the scene did not ask for.

The alternative would be changing the contract so the scene supplies a
reference image, which is a better answer and a larger change: SpecAsset
has no image-reference field today.

Model loading is written against the documented APIs of diffusers and the
Stable3DGen release. It has not been run: this repository has no GPU and no
copy of the weights.
"""

from __future__ import annotations

import io
import os
import threading
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field

app = FastAPI()

# One GPU, one generation at a time -- concurrent requests on a small card
# do not run twice as fast, they run out of memory.
_gpu_lock = threading.Lock()
_t2i = None
_hi3dgen = None
_load_error: str | None = None

# Hi3DGen leaks VRAM between generations: Stable3DGen issue #42 reports
# 14.2GB growing to 23.9GB over three runs. A long-lived service that never
# frees will exhaust the card, so this defaults on.
_EMPTY_CACHE = os.environ.get("RVS_HI3DGEN_EMPTY_CACHE", "1") != "0"


class GenerateRequest(BaseModel):
    prompt: str = Field(min_length=1, max_length=4000)
    seed: int = 0


def _load() -> tuple[object, object]:
    """Loads both stages once, on first request rather than at import.

    Deferred so the container starts and reports the reason honestly when a
    path is wrong, instead of crash-looping before anything can read it.
    """
    global _t2i, _hi3dgen, _load_error
    if _t2i is not None and _hi3dgen is not None:
        return _t2i, _hi3dgen
    if _load_error is not None:
        raise RuntimeError(_load_error)
    try:
        import torch
        from diffusers import AutoPipelineForText2Image

        t2i_path = Path(os.environ.get("RVS_HI3DGEN_T2I", ""))
        if not t2i_path.name or not t2i_path.exists():
            raise FileNotFoundError(
                "RVS_HI3DGEN_T2I is unset or missing. Hi3DGen is image-to-3D "
                "and the worker sends only a prompt, so a text-to-image stage "
                "is required to have anything to lift into a mesh."
            )
        weights = Path(os.environ.get("RVS_HI3DGEN_WEIGHTS", ""))
        if not weights.name or not weights.exists():
            raise FileNotFoundError(
                f"RVS_HI3DGEN_WEIGHTS is unset or missing at {weights}"
            )

        t2i = AutoPipelineForText2Image.from_pretrained(
            str(t2i_path), torch_dtype=torch.float16
        )
        # Staged per-module CPU offload rather than quantisation: the
        # released Hi3DGen weights are already fp16 and total about 2.65GB,
        # so quantising buys nothing -- peak memory here is activation-
        # bound, not weight-bound.
        t2i.enable_sequential_cpu_offload()

        from hi3dgen.pipelines import Hi3DGenPipeline  # type: ignore

        hi3dgen = Hi3DGenPipeline.from_pretrained(str(weights))
        hi3dgen.enable_sequential_cpu_offload()

        _t2i, _hi3dgen = t2i, hi3dgen
        return _t2i, _hi3dgen
    except Exception as error:  # noqa: BLE001 - reported, not swallowed
        _load_error = f"HI3DGEN_MODEL_LOAD_FAILED: {error}"
        raise RuntimeError(_load_error) from error


@app.get("/healthz")
def healthz() -> dict[str, object]:
    # Does not load the model on purpose: this answers "is the process up".
    # `loaded` is how an operator tells a slow first load from a dead one.
    return {
        "ok": True,
        "loaded": _hi3dgen is not None,
        "error": _load_error,
        "emptyCacheAfterEachRequest": _EMPTY_CACHE,
    }


@app.post("/v1/generate")
def generate(request: GenerateRequest) -> Response:
    import torch

    with _gpu_lock:
        try:
            t2i, hi3dgen = _load()
        except RuntimeError as error:
            raise HTTPException(status_code=503, detail=str(error)) from error
        try:
            generator = torch.Generator(device="cpu").manual_seed(request.seed)
            # One reference view, drawn from the prompt. Framed as a single
            # object on a plain background because that is what image-to-3D
            # lifts cleanly -- a scene with several things in it produces a
            # mesh of none of them.
            image = t2i(
                prompt=(
                    f"{request.prompt}, single object, centred, plain neutral "
                    "background, full object visible, product photograph"
                ),
                generator=generator,
            ).images[0]
            mesh = hi3dgen.run(image, seed=request.seed)
            buffer = io.BytesIO()
            # glb, because Blender's own importer reads it natively and the
            # worker's render script asks for exactly that.
            mesh.export(buffer, file_type="glb")
            payload = buffer.getvalue()
            if not payload:
                raise RuntimeError("the pipeline produced an empty mesh")
        except HTTPException:
            raise
        except Exception as error:  # noqa: BLE001 - named, not swallowed
            raise HTTPException(
                status_code=500, detail=f"HI3DGEN_GENERATION_FAILED: {error}"
            ) from error
        finally:
            if _EMPTY_CACHE and torch.cuda.is_available():
                torch.cuda.empty_cache()

    return Response(content=payload, media_type="model/gltf-binary")
