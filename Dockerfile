# ============================================================
# Frameiq Backend — Railway Dockerfile
# Node 20 LTS on Debian Bookworm (slim)
# Installs: FFmpeg, Node Canvas system deps, Python3
# Volume: /data  (SQLite DB + pipeline files + episode output)
# ============================================================

FROM node:20-bookworm-slim

# ── System packages ──────────────────────────────────────────
# FFmpeg        : video rendering + outro append
# canvas deps   : Node Canvas (generate-outro.cjs)
# python3/make  : native addon compilation (canvas, better-sqlite3)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    # Node Canvas system libraries
    libcairo2-dev \
    libpango1.0-dev \
    libjpeg-dev \
    libgif-dev \
    librsvg2-dev \
    libpixman-1-dev \
    # Build tools for native addons
    python3 \
    make \
    g++ \
    # Misc utils
    curl \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# ── App directory ─────────────────────────────────────────────
WORKDIR /app

# Copy package files first for layer caching
COPY package*.json ./

# Install Node deps — rebuild canvas from source for Linux
RUN npm ci --build-from-source

# Copy application source
COPY . .

# ── Volume & data paths ───────────────────────────────────────
# /data is the Railway persistent Volume mount point.
# Subdirectories are created at startup by server.js (see below).
#   /data/pipeline/   — .cjs pipeline scripts (uploaded once)
#   /data/episodes/   — rendered episode output files
#   /data/public/     — outro MP4, logos
#   /data/frameiq.db  — SQLite database

# ── Port ──────────────────────────────────────────────────────
# Railway injects $PORT; Express reads it via process.env.PORT
EXPOSE 3001

# ── Start ─────────────────────────────────────────────────────
CMD ["node", "server.js"]
