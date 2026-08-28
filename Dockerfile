FROM node:20-slim AS builder
WORKDIR /app
COPY package*.json .npmrc ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ src/
# CACHEBUST invalidates the compile layer per deploy so a new commit always
# recompiles dist/. The builder was serving a stale cached `npm run build`
# layer, shipping an old dist/ that lacked newly added routes. Pass a changing
# value (e.g. the git SHA) as a build arg; it also busts on any Dockerfile edit.
ARG CACHEBUST=dev
RUN echo "build ${CACHEBUST}" && npm run build

FROM node:20-slim
WORKDIR /app
COPY package*.json .npmrc ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist/ dist/
EXPOSE 3000
# Force HTTP mode: the image is a self-hosted HTTP server. (Hosted platforms
# like Manufact set PORT, which also selects HTTP.)
CMD ["node", "dist/index.js", "--http"]
