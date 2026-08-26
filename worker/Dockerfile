FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm i tsx
COPY . .
CMD ["npx", "tsx", "worker/index.ts"]
