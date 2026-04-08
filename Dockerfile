FROM node:22-slim

RUN apt-get update && apt-get install -y ffmpeg python3 build-essential && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@10

WORKDIR /app

# Install dependencies
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# Copy source
COPY tsconfig.json vitest.config.ts ./
COPY src/ ./src/
COPY scripts/ ./scripts/

# Create data dir
RUN mkdir -p /app/data

EXPOSE 8404

# Videos are mounted at /videos, env vars passed at runtime
# Usage: docker run -p 8404:8404 -v /path/to/videos:/videos -e BSV_PRIVATE_KEY=... -e BSV_LEECHER_KEY=... bitcointorrent
CMD ["npx", "tsx", "scripts/docker-start.ts"]
