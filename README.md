# Worker daemon

The default Compose service runs the long-lived daemon. It registers with the server, heartbeats, and claims work through:

- `POST /v1/workers/register`
- `POST /v1/workers/{workerId}/heartbeat`
- `POST /v1/workers/{workerId}/claim`
- `POST /v1/workers/{workerId}/jobs/{jobId}/complete`
- `POST /v1/workers/{workerId}/jobs/{jobId}/fail`
- `POST /v1/workers/{workerId}/jobs/{jobId}/cancelled`

Before registration, the worker verifies the pinned Chromium, SwiftShader WebGL2, local font, blocked external network, FFmpeg, FFprobe, and compiler models. A successful boot emits `worker.preflight.passed`. Claimed work emits `worker.job.claimed`, every compiler/render transition emits `worker.job.stage` with fraction and frame counts, and terminal handling emits `worker.job.completed`, `worker.job.cancelled`, or a redacted `worker.job.failed` record.

Prepare jobs download the accepted source, normalize the exact four-second interval, compile all-frame evidence, render a separate review animatic, and upload it through `preview-artifact`. After current T4 approval, render jobs repeat the deterministic SceneIR capture and upload the final delivery through `artifact`; T5 publishes that staged delivery.

Copy `.env.example` to `.env`, set `RVS_API_BASE_URL` and `RVS_WORKER_TOKEN`, then run `docker compose up -d --build`. Compose loads `.env`, starts only the daemon with `restart: always`, and provides the Docker host gateway. The default same-host API URL is `http://host.docker.internal:3200`.

On a separate worker server, `RVS_API_BASE_URL` must be the API address reachable from that server, including the host port exposed by the API deployment. For example, use `http://192.168.123.100:13001` when that address serves `/v1/workers/register`; do not use the web UI URL. `RVS_WORKER_TOKEN` must exactly match the API server's value. `RVS_API_REQUEST_TIMEOUT_MS` covers ordinary JSON calls, while `RVS_MEDIA_REQUEST_TIMEOUT_MS` covers source downloads and artifact uploads and defaults to 30 minutes.

Run the no-network runtime verification with `docker compose run --rm worker-smoke`. It checks the pinned Chrome executable, FFmpeg, compiler unit boundary, model hashes, and offline model loading without starting the worker daemon.
