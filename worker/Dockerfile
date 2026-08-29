FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npx --no-install esbuild worker/index.ts \
  --bundle \
  --platform=node \
  --format=cjs \
  --target=node22 \
  --packages=external \
  --outfile=dist/worker.cjs

FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build --chown=node:node /app/dist ./dist
USER node
EXPOSE 8080
CMD ["node", "dist/worker.cjs"]
