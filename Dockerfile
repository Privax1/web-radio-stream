FROM node:22-bookworm-slim

# ffmpeg: real-time MP3 encoding. python3: runs yt-dlp.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg python3 python3-venv ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# yt-dlp must be recent to keep working with YouTube. Rebuild the image to update it
# (docker compose build --pull --no-cache), or pin a version with --build-arg YTDLP_VERSION=...
# The [default] extra includes yt-dlp-ejs, which YouTube extraction needs (run via Node, see below).
ARG YTDLP_VERSION=
RUN python3 -m venv /opt/yt-dlp \
 && /opt/yt-dlp/bin/pip install --no-cache-dir "yt-dlp[default]${YTDLP_VERSION:+==${YTDLP_VERSION}}" \
 && ln -s /opt/yt-dlp/bin/yt-dlp /usr/local/bin/yt-dlp

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server ./server
COPY public ./public

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data \
    YTDLP_EXTRA_ARGS="--js-runtimes node"

RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

CMD ["node", "server/index.js"]
