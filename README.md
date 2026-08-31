# Worker daemon

Motion developer docs: [`docs/MOTION.md`](../../docs/MOTION.md). Error index: [`docs/errors.md`](../../docs/errors.md).

The default Compose service runs the long-lived daemon. It registers with the server, heartbeats, and claims work through:

- `POST /v1/workers/register`
- `POST /v1/workers/{workerId}/heartbeat`
- `POST /v1/workers/{workerId}/claim`
- `POST /v1/workers/{workerId}/jobs/{jobId}/complete`
- `POST /v1/workers/{workerId}/jobs/{jobId}/fail`
- `POST /v1/workers/{workerId}/jobs/{jobId}/cancelled`

Before registration, the worker verifies the pinned Chromium, SwiftShader WebGL2, local font, blocked external network, FFmpeg, FFprobe, and compiler models. A successful boot emits `worker.preflight.passed`. Claimed work emits `worker.job.claimed`, every compiler/render transition emits `worker.job.stage` with fraction and frame counts, and terminal handling emits `worker.job.completed`, `worker.job.cancelled`, or a redacted `worker.job.failed` record.

Prepare jobs download the accepted source, normalize the exact four-second interval, compile all-frame evidence, render a separate review animatic, and upload it through `preview-artifact`. After current T4 approval, render jobs repeat the deterministic SceneIR capture and upload the final delivery through `artifact`; T5 publishes that staged delivery.

This repository is **standalone**: clone it alone on a worker server, copy `.env.example` to `.env`, set `RVS_API_BASE_URL` and `RVS_WORKER_TOKEN`, then build and start:

```sh
docker compose up -d --build api-relay worker
```

The image installs pinned FFmpeg 8.0.1 and FFprobe from `docker/rvs-media-tools-1.0.0.tar.gz`, then fetches Chrome for Testing, compiler models, and the Node/Python toolchain. No parent `ref_studio` checkout, no ffmpeg source compile, and no `reference-video-studio-runtime` image is required.

From the monorepo, `pnpm up:worker` in `apps/worker` wraps the same compose flow. `pnpm up:worker --no-gpu` leaves the GPU overlay out; `--host user@gpu-box` runs against a remote Docker daemon over SSH. Omit `RVS_WORKER_ID` to generate `worker-<hostname>` automatically. The default same-host API URL is `http://host.docker.internal:3200`.

When the worker Compose stack runs on the **same machine** as the API, keep `RVS_API_BASE_URL=http://host.docker.internal:3200`. The relay already maps that name to the host gateway. Do not point it at the host's LAN address (for example `http://192.168.123.100:3200`) from inside Docker — that hairpin is what produces `connect ECONNREFUSED …:3200` and then `502 upstream unavailable` on `/v1/workers/register`.

On a **different** worker server, set `RVS_API_BASE_URL` to an address that server can reach, including the published API port, and confirm with `curl "$RVS_API_BASE_URL/health"` on that server before Compose. Do not use the web UI URL. `RVS_WORKER_TOKEN` must exactly match the API server's value. `RVS_API_REQUEST_TIMEOUT_MS` covers ordinary JSON calls, while `RVS_MEDIA_REQUEST_TIMEOUT_MS` covers source downloads and artifact uploads and defaults to 30 minutes.

Run the no-network runtime verification with `docker compose run --rm worker-smoke`. It checks the pinned Chrome executable, FFmpeg, compiler unit boundary, model hashes, and offline model loading without starting the worker daemon.

## Self-hosted generators

Two optional GPU services the worker calls directly for material it cannot
get any other way: `wan-alpha` for video with a real alpha channel,
`hi3dgen` for meshes it then renders as object-form images. Both are behind
Compose profiles, so an ordinary `docker compose up` leaves them out.

```sh
pnpm up:generators                      # both, built and waited on
pnpm up:generators --only model3d       # hi3dgen alone
pnpm up:generators --models /srv/models # where the weights are
pnpm up:generators --host user@gpu-box  # on the remote daemon
```

`up:generators` waits for each service's healthcheck before it returns --
loading a 14B model off disk is minutes, not seconds -- and fails by name
(`MODEL_CACHE_MISSING`, `GENERATOR_UNHEALTHY`) rather than leaving a
half-started stack. The raw equivalents still work:

```sh
docker compose --profile video   up -d --build wan-alpha
docker compose --profile model3d up -d --build hi3dgen
```

Then set the address in the admin console under Material generators
(`http://wan-alpha:8000`, `http://hi3dgen:8000`); the API sends it to the
worker with each assets claim. One at a time on a single card.
`generators/README.md` carries the VRAM figures, where the weights go, and
what is still unverified.
