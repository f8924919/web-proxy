# 本番ブラウザ実行基盤（#71）: 自前 Chromium 同梱イメージ。
# Playwright 公式イメージは Chromium 本体と OS 依存を同梱する。
# タグは package.json の playwright バージョンと一致させること（ここでは v1.61.0）。
# 外部ブラウザサービス（PROXY_BROWSER_CDP_URL）利用時は Chromium 不要なため、
# より軽量な Node イメージへ差し替えてもよい（docs/setup.md §9 参照）。
FROM mcr.microsoft.com/playwright:v1.61.0-noble AS base
WORKDIR /app

# 依存インストール（lockfile 厳密・再現性のため npm ci）
FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci

# ビルド
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# 実行（本番依存のみ）
FROM base AS runtime
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
COPY package.json package-lock.json next.config.ts ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
RUN npm prune --omit=dev
EXPOSE 3000
# ブラウザバック中継を使う場合は PROXY_BROWSER_* を実行時に注入する（docs/setup.md §5/§9）。
CMD ["npm", "run", "start"]
