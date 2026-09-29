# 加密便笺工作台 —— Docker 镜像
#
# 同一镜像同时服务两个 compose 服务：
# - web：vite preview 托管构建产物 dist/
# - verify：一次性运行 类型检查 + 测试 + 构建（npm run verify）

FROM node:20-alpine
WORKDIR /app

# 先拷依赖清单，利用层缓存安装依赖
COPY package.json package-lock.json* ./
RUN npm ci

# 拷贝全部源码与测试
COPY tsconfig.json vite.config.ts index.html ./
COPY src ./src
COPY test ./test

# 构建期完成类型检查与前端打包；verify 时会再次校验
RUN npm run build

EXPOSE 8080

# 默认作为静态站点启动；verify 服务在命令行覆盖为 `npm run verify`
CMD ["npm", "run", "preview", "--", "--host", "0.0.0.0", "--port", "8080"]
