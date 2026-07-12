# Flora Relight — container image for deployment.
#
# Target: Vercel container-image functions (officially support ffmpeg
# workloads), but the image is a plain Next.js server and runs anywhere
# (docker run -p 3000:3000).
#
# ffmpeg is required by ingest (probe/trim/remux), videogen (audio remux +
# md5 verification), and the side-by-side export. fonts-dejavu-core provides
# /usr/share/fonts/truetype/dejavu/DejaVuSans.ttf for the export's burned-in
# drawtext labels (see LABEL_FONT_CANDIDATES in lib/server/ffmpeg.ts).
#
# Storage: pass BLOB_READ_WRITE_TOKEN + DATABASE_URL (or POSTGRES_URL) at
# runtime to select the Vercel Blob + Neon Postgres driver; without them the
# app writes to the ephemeral local ./data directory (fs driver).

FROM node:22-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core \
  && rm -rf /var/lib/apt/lists/*

# Skip the PATH probe — the binaries live at fixed locations in this image.
ENV FFMPEG_PATH=/usr/bin/ffmpeg
ENV FFPROBE_PATH=/usr/bin/ffprobe

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

# `next start` via the package script.
CMD ["npm", "run", "start"]
