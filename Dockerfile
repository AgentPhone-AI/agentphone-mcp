FROM node:20-slim AS builder
WORKDIR /app
COPY package*.json .npmrc ./
RUN npm ci
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
