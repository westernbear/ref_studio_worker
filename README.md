# Worker daemon

The default Compose service runs the long-lived daemon. It registers with the server, heartbeats, and claims work through:

- `POST /v1/workers/register`
- `POST /v1/workers/{workerId}/heartbeat`
- `POST /v1/workers/{workerId}/claim`
- `POST /v1/workers/{workerId}/jobs/{jobId}/complete`
- `POST /v1/workers/{workerId}/jobs/{jobId}/fail`

Copy `.env.example` to `.env`, set `RVS_API_BASE_URL` and `RVS_WORKER_TOKEN`, then run `docker compose up worker`. Compose loads `.env` and provides the Docker host gateway; the default API URL is `http://host.docker.internal:3100`.
The no-network compiler verification remains available as `docker compose run --rm worker-smoke` or `pnpm compiler:smoke`.
