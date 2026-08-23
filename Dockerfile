FROM node:22-bookworm-slim

WORKDIR /app
ENV CI=true \
    COREPACK_ENABLE_PROJECT_SPEC=0 \
    PNPM_MANAGE_PACKAGE_MANAGER_VERSIONS=false \
    PNPM_CONFIG_FROZEN_LOCKFILE=true

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY src ./src
RUN corepack enable && pnpm install --frozen-lockfile

RUN pnpm build

CMD ["pnpm", "start"]
