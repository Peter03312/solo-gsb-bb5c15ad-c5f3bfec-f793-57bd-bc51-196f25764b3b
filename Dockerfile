# Node 24 LTS: ships the built-in node:sqlite module, so no native builds are needed.
FROM node:24-alpine

ENV NODE_ENV=production
WORKDIR /app

# Install dependencies first for better layer caching (fastify is pure JS).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src

# SQLite data directory (mounted as a volume by docker-compose).
ENV PORT=3000 \
    HOST=0.0.0.0 \
    DATABASE_PATH=/app/data/draws.db
RUN mkdir -p /app/data && chown -R node:node /app
USER node

EXPOSE 3000

# Schema is created automatically on startup (CREATE TABLE IF NOT EXISTS).
CMD ["node", "--disable-warning=ExperimentalWarning", "src/index.js"]
