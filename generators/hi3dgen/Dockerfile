# Hi3DGen serving image. CUDA runtime plus Blender is deliberately NOT the
# split here: Blender runs in the worker container (see
# self-hosted-3d-material-provider.ts, which renders the returned mesh
# itself with a pinned CPU-only Cycles setup). This service's job ends at
# the mesh.
#
# Hi3DGen was chosen over TRELLIS specifically because it drops the NVIDIA
# `nvdiffrast` dependency that makes TRELLIS commercially unusable, so
# nothing here needs a GL context.
#
# Weights are not baked in: they are gigabytes and the container has no
# network (worker-internal is `internal: true`). Mount them at /models --
# see generators/README.md.
FROM nvidia/cuda:12.4.1-cudnn-runtime-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    HF_HUB_OFFLINE=1 \
    TRANSFORMERS_OFFLINE=1

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      python3.10 python3-pip git libgl1 libglib2.0-0 \
 && rm -rf /var/lib/apt/lists/*

RUN python3 -m pip install --upgrade pip \
 && python3 -m pip install \
      torch==2.5.1 torchvision==0.20.1 --index-url https://download.pytorch.org/whl/cu124

# Pinned rather than floating: a silent minor bump changes what the model
# produces, and this pipeline's whole claim is reproducibility.
RUN python3 -m pip install \
      diffusers==0.32.2 \
      transformers==4.48.0 \
      accelerate==1.2.1 \
      safetensors==0.5.2 \
      trimesh==4.5.3 \
      pillow==11.1.0 \
      numpy==1.26.4

COPY requirements.txt /app/requirements.txt
RUN python3 -m pip install -r /app/requirements.txt

COPY server.py /app/server.py
WORKDIR /app

EXPOSE 8000
CMD ["python3", "-m", "uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8000"]
