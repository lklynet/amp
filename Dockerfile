FROM node:20-bookworm
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends curl postgresql-15 bzip2 tar ca-certificates cron && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* tsconfig.json ./
COPY migrations ./migrations
COPY scripts ./scripts
RUN npm install
RUN chmod +x /app/scripts/updater.sh
ENTRYPOINT ["/app/scripts/updater.sh"]
