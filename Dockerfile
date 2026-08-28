FROM node:20-slim AS builder
WORKDIR /app
COPY package*.json .npmrc ./
RUN npm ci
# CACHEBUST must invalidate the SOURCE COPY, not just the compile. The builder
# was serving a stale cached `COPY src/ src/` layer, so `npm run build`
# recompiled OLD source and shipped a dist/ missing newly added routes. Placing
# the bust BEFORE the copies forces src/ to be re-copied and recompiled every
# time this value (or the Dockerfile) changes. Pass the git SHA as the build arg
# for automatic per-commit invalidation.
ARG CACHEBUST=dev
RUN echo "cachebust ${CACHEBUST}"
COPY tsconfig.json ./
COPY src/ src/
RUN npm run build

FROM node:20-slim
WORKDIR /app
COPY package*.json .npmrc ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist/ dist/
EXPOSE 3000
# Force HTTP mode: the image is a self-hosted HTTP server. (Hosted platforms
# like Manufact set PORT, which also selects HTTP.)
CMD ["node", "dist/index.js", "--http"]
