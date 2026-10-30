FROM node:22-alpine

ENV NODE_ENV=production PORT=80 DATA_DIR=/data
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 80
CMD ["node", "server/server.mjs"]
