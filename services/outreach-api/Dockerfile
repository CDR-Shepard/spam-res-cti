# syntax=docker/dockerfile:1
# outreach-api: serves the outreach-web bundle at / and the product API at /api.
FROM node:22-slim
ENV NODE_ENV=production
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/phone/package.json packages/phone/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/auth/package.json packages/auth/package.json
COPY packages/firewall/package.json packages/firewall/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY services/cti-api/package.json services/cti-api/package.json
COPY services/outreach-api/package.json services/outreach-api/package.json
COPY apps/cti-web/package.json apps/cti-web/package.json
COPY apps/cti-desktop/package.json apps/cti-desktop/package.json
COPY apps/outreach-web/package.json apps/outreach-web/package.json
RUN npm ci --include=dev
COPY . .
RUN npm run build:outreach
EXPOSE 4100
CMD ["node", "services/outreach-api/dist/server.js"]
