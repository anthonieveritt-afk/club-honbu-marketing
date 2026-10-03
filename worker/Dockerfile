# Build from the REPO ROOT so the shared schema is included:
#   docker build -f worker/Dockerfile -t club-honbu-hq-worker .
FROM node:20-slim
ENV NODE_ENV=production
WORKDIR /app
COPY db/schema.sql db/schema.sql
COPY worker/package.json worker/package-lock.json worker/
RUN cd worker && npm ci --omit=dev
COPY worker/src worker/src
WORKDIR /app/worker
USER node
CMD ["node", "src/cli.js", "run"]
