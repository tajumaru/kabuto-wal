FROM node:24-bookworm-slim
WORKDIR /app
RUN npm install -g pnpm@9.12.3
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build
ENV HOST=0.0.0.0 PORT=3001 DATA_DIR=/data/stock-memory
EXPOSE 3001
CMD ["pnpm","start"]
