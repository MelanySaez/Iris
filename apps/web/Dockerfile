FROM node:24 AS build

WORKDIR /workspace/web

# Use the pnpm version pinned by package.json.
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY . ./
RUN pnpm build
RUN node --check ./server.mjs

FROM gcr.io/distroless/nodejs24-debian13:nonroot AS runtime

WORKDIR /workspace/web

COPY --from=build /workspace/web/dist ./dist
COPY --from=build /workspace/web/server.mjs ./server.mjs

CMD ["server.mjs"]
