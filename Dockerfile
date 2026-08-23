FROM node:22-bookworm-slim

WORKDIR /app
ENV CI=true \
    COREPACK_ENABLE_PROJECT_SPEC=0 \
    PNPM_MANAGE_PACKAGE_MANAGER_VERSIONS=false \
    PNPM_CONFIG_FROZEN_LOCKFILE=false

COPY package.json tsconfig.json ./
COPY src ./src
RUN corepack enable && pnpm install --no-frozen-lockfile

CMD ["pnpm", "test", "--run", "src/compiler-orchestrator.test.ts"]
