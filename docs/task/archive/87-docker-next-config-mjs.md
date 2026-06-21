# #87 Docker 本番起動の next.config TypeScript 依存を解消

- **Issue**: [#87](https://github.com/f8924919/web-proxy/issues/87)
- **ブランチ**: `bugfix/87-docker-next-config-mjs`
- **ステータス**: 進行中
- **関連**: 由来 #71（Dockerfile 追加）

## 背景

#71 の Dockerfile でコンテナ起動すると `next start` が `next.config.ts` 読込時に `typescript` を要求し、runtime ステージの `npm prune --omit=dev` で削除済みのため `Cannot find module 'typescript'` で失敗していた。

## 方針

`next.config.ts` → `next.config.mjs`（型は JSDoc）に変換し、本番起動時の TypeScript 依存を解消する。Dockerfile の COPY と docs 参照を更新。

## 受け入れ条件（Issue より）

- [ ] 本番起動時に TypeScript を要求しない（`.mjs` 化）
- [ ] Dockerfile の COPY を更新し `next start` が起動できる
- [ ] docs（setup.md / arch）の参照更新
- [ ] lint / 型 / テスト / ビルド green
