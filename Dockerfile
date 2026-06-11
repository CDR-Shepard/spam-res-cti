# syntax=docker/dockerfile:1
# Production image for the cti-api server. It ALSO serves the Salesforce Open
# CTI softphone bundle (apps/cti-web) at /cti/, so we build both here.
FROM node:22-slim

# Run as production at runtime, but still install devDeps (typescript/vite/tsx)
# so the build + the migration runner work. electron is a desktop-only devDep —
# never download its ~100MB binary into the server image.
ENV NODE_ENV=production
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1

WORKDIR /app

# Install dependencies first (cached unless a package manifest or the lockfile
# changes). Copy every workspace manifest so npm can resolve the workspaces.
COPY package.json package-lock.json ./
COPY services/cti-api/package.json services/cti-api/package.json
COPY apps/cti-web/package.json apps/cti-web/package.json
COPY apps/cti-desktop/package.json apps/cti-desktop/package.json
RUN npm ci --include=dev

# Build the API and the softphone bundle it serves.
COPY . .
RUN npm run build:web && npm run build:api

# Hosts inject the listen port via PORT (config honors it); 4000 is the default.
EXPOSE 4000

# Apply DB migrations, then start the server. If migrations fail (e.g. DB not
# ready yet) the container exits and the platform restarts it.
CMD ["sh", "-c", "npm --workspace services/cti-api run migrate && node services/cti-api/dist/server.js"]
