FROM node:24-alpine AS build
WORKDIR /app/client
COPY client/package.json client/package-lock.json ./
RUN npm ci
COPY client ./
RUN npm run build

FROM node:24-alpine
ENV NODE_ENV=production
# 主+副 (主音声と副音声を左右に振り分ける) で音声を作り直すのに使う
RUN apk add --no-cache ffmpeg
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server ./server
COPY --from=build /app/client/dist ./client/dist
USER node
CMD ["node", "server/index.mjs"]
