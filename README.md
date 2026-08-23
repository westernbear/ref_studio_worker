# Worker daemon

The default Compose service runs the long-lived daemon. It registers with the server, heartbeats, and claims work through:

- `POST /v1/workers/register`
- `POST /v1/workers/{workerId}/heartbeat`
- `POST /v1/workers/{workerId}/claim`
- `POST /v1/workers/{workerId}/jobs/{jobId}/complete`
- `POST /v1/workers/{workerId}/jobs/{jobId}/fail`

Copy `.env.example` to `.env`, set `RVS_API_BASE_URL` and `RVS_WORKER_TOKEN`, then run `docker compose up worker`. Compose loads `.env` and provides the Docker host gateway; the default same-host API URL is `http://host.docker.internal:3200`. On a separate worker server, set `RVS_API_BASE_URL=http://<api-server-host>:3200`; set `RVS_API_REQUEST_TIMEOUT_MS` higher than `30000` only if the API connection itself is slow.
The no-network compiler verification remains available as `docker compose run --rm worker-smoke` or `pnpm compiler:smoke`.
