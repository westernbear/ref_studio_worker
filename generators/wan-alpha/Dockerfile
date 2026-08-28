# Wan-Alpha serving image.
#
# Based on the PyTorch runtime image rather than nvidia/cuda, because torch
# and its CUDA libraries are the bulk of this build -- around 2.5GB of
# wheels from download.pytorch.org, which is slow from most of the world
# and is the single biggest thing to stop downloading. The base image
# already has them, and comes from Docker Hub, which mirrors well.
#
# Override it if this tag is wrong for your driver:
#   docker compose build --build-arg TORCH_IMAGE=pytorch/pytorch:<tag> wan-alpha
ARG TORCH_IMAGE=pytorch/pytorch:2.5.1-cuda12.4-cudnn9-runtime
FROM ${TORCH_IMAGE}

# Point these at a mirror when the defaults are slow. In Korea, for
# example:
#   docker compose build \
#     --build-arg APT_MIRROR=mirror.kakao.com \
#     --build-arg PIP_INDEX_URL=https://mirror.kakao.com/pypi/simple \
#     wan-alpha
ARG APT_MIRROR=""
ARG PIP_INDEX_URL="https://pypi.org/simple"

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    HF_HUB_OFFLINE=1 \
    TRANSFORMERS_OFFLINE=1

# `rm -rf /var/lib/apt/lists/*` BEFORE update, not only after: a stale
# index shipped in the base layer (or served by a caching proxy) is what
# produces "Hashes of received file" mismatches, and apt will keep using
# the old one rather than admit it. Retries cover a merely flaky link.
RUN set -eux; \
    rm -rf /var/lib/apt/lists/*; \
    if [ -n "${APT_MIRROR}" ]; then \
      sed -i "s|http://archive.ubuntu.com|http://${APT_MIRROR}|g; s|http://security.ubuntu.com|http://${APT_MIRROR}|g" \
        /etc/apt/sources.list /etc/apt/sources.list.d/* 2>/dev/null || true; \
    fi; \
    apt-get -o Acquire::Retries=5 update; \
    apt-get install -y --no-install-recommends ffmpeg; \
    rm -rf /var/lib/apt/lists/*

# A BuildKit cache mount, so a rebuild reuses what it already downloaded
# instead of fetching every wheel again. The previous PIP_NO_CACHE_DIR=1
# was actively working against that.
#
# torch and torchvision are NOT listed: they come with the base image, and
# reinstalling them would pull the very gigabytes this image exists to
# avoid. Everything else is pinned rather than floating -- a silent minor
# bump changes what the model draws, and this pipeline's whole claim is
# reproducibility.
COPY requirements.txt /app/requirements.txt
RUN --mount=type=cache,target=/root/.cache/pip \
    python3 -m pip install --index-url "${PIP_INDEX_URL}" \
      diffusers==0.32.2 \
      transformers==4.48.0 \
      accelerate==1.2.1 \
      safetensors==0.5.2 \
      peft==0.14.0 \
      gguf==0.13.0 \
      imageio==2.36.1 \
      numpy==1.26.4 \
 && python3 -m pip install --index-url "${PIP_INDEX_URL}" -r /app/requirements.txt

COPY server.py /app/server.py
WORKDIR /app

EXPOSE 8000
CMD ["python3", "-m", "uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8000"]
