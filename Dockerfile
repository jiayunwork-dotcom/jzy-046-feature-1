# syntax=docker/dockerfile:1
# 单镜像多阶段构建，全程锁定 Node.js 20：
#   1) client-builder : Vite 构建 React 前端为静态产物（输出到 /out）
#   2) deps           : 安装后端生产依赖
#   3) runtime        : node:20-slim 运行 Express，静态文件由 Express 托管
FROM node:20-slim AS client-builder
WORKDIR /app/client
COPY client/package*.json ./
RUN npm ci || npm install
COPY client/ ./
# 把构建产物输出到独立目录，避免跨 ../ 路径
RUN npx vite build --outDir /out --emptyOutDir

FROM node:20-slim AS deps
WORKDIR /app/server
COPY server/package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev

FROM node:20-slim AS runtime
ENV NODE_ENV=production
ENV PORT=3000
ENV STATIC_DIR=/app/server/public
WORKDIR /app/server
RUN apt-get update \
  && apt-get install -y --no-install-recommends tini \
  && rm -rf /var/lib/apt/lists/*
# 后端代码与依赖
COPY --from=deps /app/server/node_modules ./node_modules
COPY server/ ./
# 前端静态产物（Express 在 STATIC_DIR 下托管）
COPY --from=client-builder /out ./public
EXPOSE 3000
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/server.js"]
