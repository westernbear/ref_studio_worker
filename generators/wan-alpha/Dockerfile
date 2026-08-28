# Wan-Alpha serving image. CUDA runtime plus ffmpeg, because the server
# encodes the finished clip itself rather than handing back raw frames.
#
# The torch/diffusers stack and the Wan-Alpha code are installed here; the
# weights are not. They are tens of gigabytes and the container has no
# network (worker-internal is `internal: true`), so they are mounted from
# the host at /models -- see generators/README.md.
FROM nvidia/cuda:12.4.1-cudnn-runtime-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    HF_HUB_OFFLINE=1 \
    TRANSFORMERS_OFFLINE=1

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      python3.10 python3-pip ffmpeg git \
 && rm -rf /var/lib/apt/lists/*

RUN python3 -m pip install --upgrade pip \
 && python3 -m pip install \
      torch==2.5.1 torchvision==0.20.1 --index-url https://download.pytorch.org/whl/cu124

# Pinned rather than floating: a silent minor bump in any of these changes
# what the model draws, and this pipeline's whole claim is reproducibility.
RUN python3 -m pip install \
      diffusers==0.32.2 \
      transformers==4.48.0 \
      accelerate==1.2.1 \
      safetensors==0.5.2 \
      peft==0.14.0 \
      gguf==0.13.0 \
      imageio==2.36.1 \
      numpy==1.26.4

COPY requirements.txt /app/requirements.txt
RUN python3 -m pip install -r /app/requirements.txt

COPY server.py /app/server.py
WORKDIR /app

EXPOSE 8000
CMD ["python3", "-m", "uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8000"]
