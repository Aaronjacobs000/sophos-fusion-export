# The Unofficial Sophos Fusion Data Exporter as a container, for the Azure
# Container Apps job in deploy/azure (or any container host). The image holds
# the compiled exporter and Node.js only: no dependencies, no credentials, no
# data. It runs as the unprivileged node user (uid 1000).
#
#   docker build -t sophos-fusion-export .
#   docker run --rm -v "$PWD/export:/data" --env-file fusion-export.env sophos-fusion-export run --out /data

ARG NODE_IMAGE=node:24.22.1-alpine3.24@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53

# The build output is plain JavaScript, so it is built once on the build machine for every platform.
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS build
WORKDIR /src
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY src ./src
RUN npm run build && find dist -name '*.map' -delete

FROM ${NODE_IMAGE}
LABEL org.opencontainers.image.title="Unofficial Sophos Fusion Data Exporter" \
      org.opencontainers.image.description="Unofficial, not a Sophos product. Reads the documented Sophos APIs and writes a star schema of CSV files for Power BI and other BI tools." \
      org.opencontainers.image.source="https://github.com/Aaronjacobs000/sophos-fusion-export" \
      org.opencontainers.image.licenses="MIT"
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /src/package.json ./package.json
COPY --from=build /src/dist ./dist
RUN mkdir /data && chown node:node /data
USER node
ENTRYPOINT ["node", "/app/dist/cli.js"]
CMD ["run", "--out", "/data"]
