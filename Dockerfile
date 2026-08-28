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
# Bust the COPY dist/ layer. The platform's remote cache also caches the dist
# copy, so a changed committed dist/ was shipped stale. Changing this value (or
# this line) forces the copy to re-run. Pass the git SHA as the build arg for
# automatic per-commit invalidation.
ARG DIST_CACHEBUST=2
RUN echo "dist cachebust ${DIST_CACHEBUST}"
COPY dist/ dist/
EXPOSE 3000
# Force HTTP mode: the image is a self-hosted HTTP server. (Hosted platforms
# like Manufact set PORT, which also selects HTTP.)
CMD ["node", "dist/index.js", "--http"]
