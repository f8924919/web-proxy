// 本番（next start）でも TypeScript 不要で読み込めるよう .mjs とする（#87）。
// next start は .ts 設定を typescript でトランスパイルするため、devDependency を
// prune した本番イメージでは next.config.ts が読めず起動に失敗していた。
/** @type {import('next').NextConfig} */
const nextConfig = {
  assetPrefix: process.env.NEXT_PUBLIC_BASE_PATH ?? "",
  // パス反映ナビ（/browse/<scheme>/<host>/<path>・#115）でターゲット root（path="/"）が
  // 末尾スラッシュ付き URL（…/browse/https/host/）を生む。Next 既定の trailing-slash 正規化は
  // これを 308 で …/browse/https/host へ飛ばすが、その Location は BASE_PATH を知らないため
  // リバースプロキシ配下でプレフィックスを失い 404 になる（#74 と同類）。catch-all ルートが
  // 末尾スラッシュ有無の両方を直接処理できるよう、自動リダイレクトを無効化する。
  skipTrailingSlashRedirect: true,
  // ホーム / はプロキシ自身の UI（アドレスバー入力）。React コンポーネントのため
  // レスポンスヘッダーを直接付与できず、ここで X-Frame-Options: DENY を付けて
  // クリックジャッキングを防ぐ。中継パス（/browse・/api/proxy）には付けない
  // （iframe 埋め込み中継を壊さないため。エラー / 案内ページは headers.ts の
  // htmlUiHeaders で個別付与する）。
  // 仕様: docs/spec/features/proxy.md §プロキシ UI レスポンスのクリックジャッキング防止（#131）
  async headers() {
    return [
      {
        source: "/",
        headers: [{ key: "X-Frame-Options", value: "DENY" }],
      },
    ];
  },
};

export default nextConfig;
