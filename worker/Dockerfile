FROM node:22-slim@sha256:4d676821dff059fd00d277ee4261ef34ea712317fed0737c03941481b5760c96 AS build
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    gcc=4:12.2.0-3 \
    libc6-dev=2.36-9+deb12u14 \
  && rm -rf /var/lib/apt/lists/*
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
RUN npx --no-install esbuild scripts/verify-offer-pdf-renderer.mts \
  --bundle \
  --platform=node \
  --format=esm \
  --target=node22 \
  --packages=external \
  --outfile=dist/verify-offer-pdf-renderer.mjs
RUN gcc -shared -fPIC -O2 -Wall -Wextra -Werror -Wl,-z,relro,-z,now \
  worker/process-isolation.c \
  -o dist/worker-nodump.so

# Playwright-Paket und Browserrevision muessen exakt zusammenpassen. Das
# offizielle Noble-Image bringt Chromium samt Systembibliotheken mit; der
# Container laeuft unten trotzdem als unprivilegierter pwuser und der Code
# erzwingt chromiumSandbox=true.
FROM mcr.microsoft.com/playwright:v1.62.1-noble@sha256:c091b21d9fae78c76e85cd4356431e9b018402f172a214fc7d7a5e9a7e29d8ac AS runtime
ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build --chown=pwuser:pwuser /app/dist ./dist
COPY --from=build --chown=root:root /app/dist/worker-nodump.so /usr/local/lib/worker-nodump.so
ENV LD_PRELOAD=/usr/local/lib/worker-nodump.so
USER pwuser
EXPOSE 8080
CMD ["node", "dist/worker.cjs"]
