# Sanate WhatsApp Bot — Multi-instance Worker
# Funciona en Render, Fly.io, Docker, Kubernetes, etc.

FROM node:20-slim AS base

# System deps for Baileys (audio transcoding + image processing)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies (cache layer)
COPY package*.json ./
RUN npm install --omit=dev

# Copy source code
COPY . .

# Persistent storage (auth_info, antiban-state)
RUN mkdir -p /app/auth_info

# Health endpoint port
EXPOSE 10000
ENV PORT=10000

# Each worker is bound to ONE store via STORE_ID env var
# - STORE_ID=00000000-... → default store (backward compat)
# - STORE_ID=<other-uuid> → isolated worker for that tienda
# DEVICE_ID auto-syncs to STORE_ID for auth namespace isolation
# WA_PROXY_URL with -session-{shortId} suffix for sticky residential proxy

HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD curl -f http://localhost:10000/ || exit 1

CMD ["node", "src/index.js"]
