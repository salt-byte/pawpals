# ── Stage 1: 构建前端 ────────────────────────────────────────────────
FROM node:22-slim AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# ── Stage 2: 运行时 ──────────────────────────────────────────────────
FROM node:22-slim

WORKDIR /app

# 安装 openclaw CLI（运行时依赖）
RUN apt-get update && apt-get install -y --no-install-recommends \
      curl ca-certificates python3 python3-pip \
    && npm install -g openclaw \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# 只复制运行时需要的文件
COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY server.ts tsconfig.json ./
COPY resources ./resources
COPY scripts ./scripts

# Railway 会挂载 Volume 到这个路径（持久化数据）
ENV PAWPALS_HOME=/data/pawpals
ENV NODE_ENV=production
ENV PORT=3010

EXPOSE 3010

# 启动前先初始化目录
CMD ["sh", "-c", "mkdir -p /data/pawpals && node --import tsx/esm server.ts"]
