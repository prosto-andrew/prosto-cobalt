FROM node:24-alpine AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

FROM base AS build
WORKDIR /app
COPY . /app

RUN corepack enable
RUN apk add --no-cache python3 alpine-sdk

RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --prod --frozen-lockfile

RUN pnpm deploy --filter=@imput/cobalt-api --prod /prod/api

FROM base AS api
WORKDIR /app

COPY --from=build --chown=node:node /prod/api /app

# the api listens on loopback by default; inside the container it has to
# listen on all interfaces so the published port works. restrict exposure
# with the host side of the port mapping (e.g. 127.0.0.1:9000:9000).
ENV API_LISTEN_ADDRESS=0.0.0.0

USER node

EXPOSE 9000
CMD [ "node", "src/cobalt" ]
