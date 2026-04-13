FROM node:22-slim
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY . .
RUN npm run build

# CrowClaw HTTP server listens on port 8787 by default (configurable via PORT env).
# Starts the Node.js runtime server, not the CLI REPL.
EXPOSE 8787
ENTRYPOINT ["node"]
CMD ["packages/runtime-node/dist/index.js"]
