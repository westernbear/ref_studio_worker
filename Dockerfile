FROM python@sha256:356b0d18f9385f4bdcc673af60e1e64c9d1504952e4ec36ee32044c722a6bc4e AS python-runtime

FROM node@sha256:65932751ed4073ed02f5c04e494e4b2572a891b7dbea0568a863dc80341bf848 AS assets

RUN apt-get -o Acquire::Retries=5 -o Acquire::http::No-Cache=true -o Acquire::http::Pipeline-Depth=0 update && \
    apt-get -o Acquire::Retries=5 -o Acquire::http::No-Cache=true -o Acquire::http::Pipeline-Depth=0 install -y --no-install-recommends \
    ca-certificates curl unzip && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /opt/rvs/model-artifacts /opt/rvs/models/easyocr /opt/rvs/vendor /opt/rvs/fonts && \
    curl -fsSLo /tmp/chrome.zip https://storage.googleapis.com/chrome-for-testing-public/151.0.7922.138/linux64/chrome-linux64.zip && \
    echo "f2c1d48c310a2fc79aad59e985103902f27b70fd186b3f663ee67c4c722f5566  /tmp/chrome.zip" | sha256sum -c - && \
    unzip -q /tmp/chrome.zip -d /tmp/chrome && mv /tmp/chrome/chrome-linux64 /opt/chrome && \
    curl -fsSLo /opt/rvs/model-artifacts/rvm_mobilenetv3.pth https://github.com/PeterL1n/RobustVideoMatting/releases/download/v1.0.0/rvm_mobilenetv3.pth && \
    echo "3c7c1d92033f7c38d6577c481d13a195d7d80a159b960f4f3119ac7b534cf4f8  /opt/rvs/model-artifacts/rvm_mobilenetv3.pth" | sha256sum -c - && \
    curl -fsSLo /opt/rvs/model-artifacts/midas_v21_small_256.pt https://github.com/isl-org/MiDaS/releases/download/v2_1/midas_v21_small_256.pt && \
    echo "70d6b9c891758c67f974a6097fb0c608c7ee67fb81ac3e5588847d5596d56fca  /opt/rvs/model-artifacts/midas_v21_small_256.pt" | sha256sum -c - && \
    curl -fsSLo /opt/rvs/model-artifacts/mobile_sam.pt https://huggingface.co/dhkim2810/MobileSAM/resolve/main/mobile_sam.pt && \
    echo "6dbb90523a35330fedd7f1d3dfc66f995213d81b29a5ca8108dbcdd4e37d6c2f  /opt/rvs/model-artifacts/mobile_sam.pt" | sha256sum -c - && \
    curl -fsSLo /opt/rvs/model-artifacts/easyocr-craft.zip https://github.com/JaidedAI/EasyOCR/releases/download/pre-v1.1.6/craft_mlt_25k.zip && \
    echo "8dc6a1c703a89ed56308ef742d26ebd45c656248cbbbda6e7fe60e569f873e65  /opt/rvs/model-artifacts/easyocr-craft.zip" | sha256sum -c - && \
    curl -fsSLo /opt/rvs/model-artifacts/easyocr-korean.zip https://github.com/JaidedAI/EasyOCR/releases/download/v1.3/korean_g2.zip && \
    echo "3cdaad22676723040ceb5c6fe72089d656b3bc1f630889c373ade86f3ab38c2e  /opt/rvs/model-artifacts/easyocr-korean.zip" | sha256sum -c - && \
    curl -fsSLo /opt/rvs/model-artifacts/easyocr-english.zip https://github.com/JaidedAI/EasyOCR/releases/download/v1.3/english_g2.zip && \
    echo "1b5eaebf1c062de6205560c97ffcfa8dc0e6f413c340e8adc5cfc57e159f61ff  /opt/rvs/model-artifacts/easyocr-english.zip" | sha256sum -c - && \
    cp /opt/rvs/model-artifacts/rvm_mobilenetv3.pth /opt/rvs/models/ && \
    cp /opt/rvs/model-artifacts/midas_v21_small_256.pt /opt/rvs/models/ && \
    cp /opt/rvs/model-artifacts/mobile_sam.pt /opt/rvs/models/ && \
    unzip -q /opt/rvs/model-artifacts/easyocr-craft.zip -d /opt/rvs/models/easyocr && \
    unzip -q /opt/rvs/model-artifacts/easyocr-korean.zip -d /opt/rvs/models/easyocr && \
    unzip -q /opt/rvs/model-artifacts/easyocr-english.zip -d /opt/rvs/models/easyocr && \
    curl -fsSLo /tmp/rvm-source.tar.gz https://github.com/PeterL1n/RobustVideoMatting/archive/53d74c6826735f01f4406b5ca9075eee27bec094.tar.gz && \
    echo "dfc067a77e56bd88590264f7392a22328654acbabca8a2f9c66bcd4f3b107e1e  /tmp/rvm-source.tar.gz" | sha256sum -c - && \
    mkdir -p /opt/rvs/vendor/rvm && tar -xzf /tmp/rvm-source.tar.gz -C /opt/rvs/vendor/rvm --strip-components=1 && \
    curl -fsSLo /tmp/midas-source.tar.gz https://github.com/isl-org/MiDaS/archive/454597711a62eabcbf7d1e89f3fb9f569051ac9b.tar.gz && \
    echo "9ba43907030b57a0cd21ab9c2029611e8f587c54e8093f0fd6ab5b14016a0ed6  /tmp/midas-source.tar.gz" | sha256sum -c - && \
    mkdir -p /opt/rvs/vendor/midas && tar -xzf /tmp/midas-source.tar.gz -C /opt/rvs/vendor/midas --strip-components=1 && \
    curl -fsSLo /tmp/mobilesam-source.tar.gz https://github.com/ChaoningZhang/MobileSAM/archive/f706ad9c4eb7f219c00d9050e46328518ffb65d2.tar.gz && \
    echo "afe5c71ff9d562ce8811bdfb18712dc2d637c33f0c73c1e7300d9717ebcf91b3  /tmp/mobilesam-source.tar.gz" | sha256sum -c - && \
    mkdir -p /opt/rvs/vendor/mobilesam && tar -xzf /tmp/mobilesam-source.tar.gz -C /opt/rvs/vendor/mobilesam --strip-components=1 && \
    curl -fsSLo /tmp/wanted-sans.zip https://github.com/wanteddev/wanted-sans/releases/download/v1.0.3/WantedSans-1.0.3.zip && \
    echo "e0734c1e29426d2a6213650383fec37051145fccaed8360c8fe30d75321d98ab  /tmp/wanted-sans.zip" | sha256sum -c - && \
    unzip -p /tmp/wanted-sans.zip variable/WantedSansVariable.ttf > /opt/rvs/fonts/WantedSansVariable.ttf

FROM node@sha256:65932751ed4073ed02f5c04e494e4b2572a891b7dbea0568a863dc80341bf848 AS runtime

ENV DEBIAN_FRONTEND=noninteractive \
    CI=true \
    COREPACK_ENABLE_PROJECT_SPEC=0 \
    PNPM_MANAGE_PACKAGE_MANAGER_VERSIONS=false \
    PNPM_CONFIG_FROZEN_LOCKFILE=true \
    PATH=/opt/compiler-venv/bin:/opt/rvs/bin:/usr/local/bin:$PATH \
    LD_LIBRARY_PATH=/opt/rvs/lib \
    PYTHONPATH=/app \
    CHROME_PATH=/opt/chrome/chrome \
    RVS_PYTHON_PATH=/opt/compiler-venv/bin/python \
    RVS_MODEL_MANIFEST_PATH=/app/compiler/model-manifest.json \
    RVS_MODEL_ARTIFACTS_DIR=/opt/rvs/model-artifacts \
    RVS_MODEL_DIR=/opt/rvs/models \
    RVS_VENDOR_DIR=/opt/rvs/vendor \
    RVS_FONT_PATH=/opt/rvs/fonts/WantedSansVariable.ttf \
    RVS_FFMPEG_PATH=/usr/bin/ffmpeg \
    RVS_FFPROBE_PATH=/usr/bin/ffprobe \
    HF_HUB_OFFLINE=1 \
    TRANSFORMERS_OFFLINE=1 \
    OMP_NUM_THREADS=4 \
    MKL_NUM_THREADS=4 \
    UV_PROJECT_ENVIRONMENT=/opt/compiler-venv

RUN apt-get -o Acquire::Retries=5 -o Acquire::http::No-Cache=true -o Acquire::http::Pipeline-Depth=0 update && \
    apt-get -o Acquire::Retries=5 -o Acquire::http::No-Cache=true -o Acquire::http::Pipeline-Depth=0 install -y --no-install-recommends \
    ca-certificates curl ffmpeg libasound2 libatk-bridge2.0-0 libatk1.0-0 libcairo2 \
    libatspi2.0-0 libcups2 libdbus-1-3 libdrm2 libfontconfig1 libfreetype6 \
    libgbm1 libglib2.0-0 libharfbuzz0b libnspr4 libnss3 libpango-1.0-0 libx11-6 \
    libx11-xcb1 libxcb1 libxcomposite1 libxdamage1 libxext6 libxfixes3 \
    libxkbcommon0 libxrandr2 && rm -rf /var/lib/apt/lists/*
COPY --from=python-runtime /usr/local/ /usr/local/
COPY --from=assets /opt/chrome/ /opt/chrome/
COPY --from=assets /opt/rvs/model-artifacts/ /opt/rvs/model-artifacts/
COPY --from=assets /opt/rvs/models/ /opt/rvs/models/
COPY --from=assets /opt/rvs/vendor/ /opt/rvs/vendor/
COPY --from=assets /opt/rvs/fonts/ /opt/rvs/fonts/
RUN curl -fsSLo /tmp/uv.tar.gz https://github.com/astral-sh/uv/releases/download/0.11.8/uv-x86_64-unknown-linux-gnu.tar.gz && \
    echo "56dd1b66701ecb62fe896abb919444e4b83c5e8645cca953e6ddd496ff8a0feb  /tmp/uv.tar.gz" | sha256sum -c - && \
    tar -xzf /tmp/uv.tar.gz -C /tmp && \
    install /tmp/uv-x86_64-unknown-linux-gnu/uv /usr/local/bin/uv

WORKDIR /app
COPY compiler/pyproject.toml compiler/uv.lock ./compiler/
RUN uv sync --project compiler --frozen --no-dev --no-install-project
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json .prettierignore ./
RUN corepack enable && corepack prepare pnpm@11.20.0 --activate && pnpm install --frozen-lockfile
COPY compiler ./compiler
COPY src ./src
RUN pnpm build && pnpm prune --prod

USER node
CMD ["node", "dist/index.js"]
