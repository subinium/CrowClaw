FROM node:22-slim
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY . .
RUN npm run build

EXPOSE 8787
ENTRYPOINT ["node"]
CMD ["packages/cli/dist/index.js"]
