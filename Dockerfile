# Single stage: copy the committed, prebuilt dist/ and install prod deps.
#
# We deliberately do NOT run `tsc` here. The deploy platform's remote build
# cache would not invalidate the compile/source-copy layers, so it kept shipping
# a stale dist/ that lacked newly added code (e.g. the OpenAI Apps challenge
# route). Copying the committed dist/ removes the build step from the image
# entirely, so the deployed code is exactly what is in the repo.
#
# Maintenance: run `npm run build` and commit dist/ whenever src/ changes.
FROM node:20-slim
WORKDIR /app
COPY package*.json .npmrc ./
RUN npm ci --omit=dev
COPY dist/ dist/
EXPOSE 3000
# Force HTTP mode: the image is a self-hosted HTTP server. (Hosted platforms
# like Manufact set PORT, which also selects HTTP.)
CMD ["node", "dist/index.js", "--http"]
