"""Wan-Alpha behind the one HTTP contract the worker already speaks.

The worker calls ``POST /v1/generate`` with ``{"prompt": ..., "seed": ...}``
and expects raw mp4 bytes back -- see
``apps/worker/src/self-hosted-video-material-provider.ts``, which is the
only client this service will ever have.

Two things that contract implies, and which the worker relies on:

* The frame is **double height**: RGB colour on top, the alpha channel
  re-encoded as a grayscale luma matte on the bottom. Ordinary mp4 has no
  alpha plane, and an opaque clip cannot be composited into a scene, so the
  matte travels inside the picture. The worker splits it back apart. This
  is the whole reason Wan-Alpha was chosen over an ordinary video model.
* The native size and timing (480x832, 81 frames, 16fps) are returned
  unchanged. The worker retimes and rescales to the scene's own canvas
  afterwards, and doing it twice would only lose detail.

Determinism: the seed the worker sends is the seed used. Same prompt and
same seed should give the same clip. That is not the same guarantee the
renderer makes -- diffusion on a GPU is not bit-reproducible across driver
versions -- which is exactly why generated material is pinned as an
artifact and hashed once, rather than regenerated per render.

Model loading is written against the documented APIs of diffusers and the
Wan-Alpha release. It has not been run: this repository has no GPU and no
copy of the weights. Every failure below is named rather than swallowed, so
a first run says which step was wrong instead of returning something that
is not a clip.
"""

from __future__ import annotations

import io
import os
import subprocess
import tempfile
import threading
from pathlib import Path

import numpy as np
from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field

# The native output this model produces, mirrored from WAN_ALPHA_NATIVE in
# self-hosted-video-material-provider.ts. The two must agree: the worker
# sizes its retime from its own copy.
NATIVE_WIDTH = 480
NATIVE_HEIGHT = 832
NATIVE_FPS = 16
NATIVE_FRAMES = 81

app = FastAPI()

# One GPU, one generation at a time. Concurrent requests on a 12GB card do
# not run twice as fast; they run out of memory. The worker resolves scene
# assets serially anyway, so this only guards against a second worker.
_gpu_lock = threading.Lock()
_pipeline = None
_pipeline_error: str | None = None


class GenerateRequest(BaseModel):
    prompt: str = Field(min_length=1, max_length=4000)
    seed: int = 0


def _load_pipeline():
    """Loads once, on first request rather than at import.

    Deferred so the container starts (and reports unhealthy honestly) even
    when a path is wrong, instead of crash-looping before anything can read
    the error.
    """
    global _pipeline, _pipeline_error
    if _pipeline is not None:
        return _pipeline
    if _pipeline_error is not None:
        raise RuntimeError(_pipeline_error)
    try:
        import torch
        from diffusers import AutoencoderKLWan, WanPipeline

        base = Path(os.environ["RVS_WAN_BASE"])
        dora = Path(os.environ["RVS_WAN_DORA"])
        vae_rgb = Path(os.environ["RVS_WAN_VAE_RGB"])
        vae_alpha = Path(os.environ["RVS_WAN_VAE_ALPHA"])
        for name, path in (
            ("RVS_WAN_BASE", base),
            ("RVS_WAN_DORA", dora),
            ("RVS_WAN_VAE_RGB", vae_rgb),
            ("RVS_WAN_VAE_ALPHA", vae_alpha),
        ):
            if not path.exists():
                raise FileNotFoundError(f"{name} does not exist at {path}")

        pipeline = WanPipeline.from_pretrained(
            str(base), torch_dtype=torch.float16
        )
        # Wan-Alpha's RGBA output is a DoRA plus two custom VAE decoders on
        # top of the Wan2.1 base -- the colour pass and the matte pass are
        # decoded separately from the same latents.
        pipeline.load_lora_weights(str(dora))
        pipeline.vae_rgb = AutoencoderKLWan.from_pretrained(
            str(vae_rgb), torch_dtype=torch.float16
        )
        pipeline.vae_alpha = AutoencoderKLWan.from_pretrained(
            str(vae_alpha), torch_dtype=torch.float16
        )
        # Sequential offload, not .to("cuda"): the point of the quantised
        # base is fitting a 12GB card, and the text encoder alone undoes
        # that if everything is resident at once.
        pipeline.enable_sequential_cpu_offload()
        _pipeline = pipeline
        return pipeline
    except Exception as error:  # noqa: BLE001 - reported, not swallowed
        _pipeline_error = f"WAN_ALPHA_MODEL_LOAD_FAILED: {error}"
        raise RuntimeError(_pipeline_error) from error


def _stack(rgb: np.ndarray, alpha: np.ndarray) -> np.ndarray:
    """RGB on top, alpha as grayscale on the bottom, one double-height frame.

    The convention the worker splits back apart. Named `wan-alpha@1` in the
    provenance it records, so a later consumer knows what it is looking at.
    """
    if rgb.shape[:3] != alpha.shape[:3]:
        raise ValueError("colour and matte passes disagree on shape")
    matte = alpha
    if matte.ndim == 4 and matte.shape[-1] == 1:
        matte = np.repeat(matte, 3, axis=-1)
    return np.concatenate([rgb, matte], axis=1)


def _encode(frames: np.ndarray) -> bytes:
    """Frames to an ordinary yuv420p mp4.

    Plain H.264: the stacked frame is opaque as far as the codec is
    concerned, which is the entire trick. The worker re-encodes to the
    scene's canvas afterwards, so nothing here is the final quality
    decision -- but the matte must survive, hence the low CRF.
    """
    with tempfile.TemporaryDirectory() as workspace:
        raw = Path(workspace) / "frames.rgb"
        out = Path(workspace) / "native.mp4"
        with raw.open("wb") as handle:
            handle.write(np.ascontiguousarray(frames, dtype=np.uint8).tobytes())
        height, width = frames.shape[1], frames.shape[2]
        result = subprocess.run(
            [
                "ffmpeg", "-nostdin", "-y",
                "-f", "rawvideo",
                "-pix_fmt", "rgb24",
                "-s", f"{width}x{height}",
                "-r", str(NATIVE_FPS),
                "-i", str(raw),
                "-an",
                "-c:v", "libx264",
                "-preset", "medium",
                "-crf", "16",
                "-pix_fmt", "yuv420p",
                "-movflags", "+faststart",
                str(out),
            ],
            capture_output=True,
        )
        if result.returncode != 0:
            raise RuntimeError(
                "WAN_ALPHA_ENCODE_FAILED: "
                + result.stderr.decode("utf-8", "replace")[-400:]
            )
        return out.read_bytes()


@app.get("/healthz")
def healthz() -> dict[str, object]:
    # Deliberately does not load the model: this answers "is the process
    # up", and a 10-minute load would otherwise make the container look
    # dead while it was working. `loaded` is how an operator tells the
    # difference.
    return {
        "ok": True,
        "loaded": _pipeline is not None,
        "error": _pipeline_error,
        "native": {
            "width": NATIVE_WIDTH,
            "height": NATIVE_HEIGHT,
            "fps": NATIVE_FPS,
            "frames": NATIVE_FRAMES,
        },
    }


@app.post("/v1/generate")
def generate(request: GenerateRequest) -> Response:
    import torch

    with _gpu_lock:
        try:
            pipeline = _load_pipeline()
        except RuntimeError as error:
            raise HTTPException(status_code=503, detail=str(error)) from error
        try:
            generator = torch.Generator(device="cpu").manual_seed(request.seed)
            result = pipeline(
                prompt=request.prompt,
                height=NATIVE_HEIGHT,
                width=NATIVE_WIDTH,
                num_frames=NATIVE_FRAMES,
                generator=generator,
            )
            rgb = np.asarray(result.frames[0])
            alpha = np.asarray(result.alpha[0])
            stacked = _stack(rgb, alpha)
            video = _encode(stacked)
        except HTTPException:
            raise
        except Exception as error:  # noqa: BLE001 - named, not swallowed
            raise HTTPException(
                status_code=500, detail=f"WAN_ALPHA_GENERATION_FAILED: {error}"
            ) from error
        finally:
            # PyTorch does not reliably return reserved memory to the OS,
            # and a long-lived service that never empties the cache will
            # exhaust the card over a handful of requests.
            if torch.cuda.is_available():
                torch.cuda.empty_cache()

    return Response(content=video, media_type="video/mp4")
