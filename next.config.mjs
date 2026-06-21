// 本番（next start）でも TypeScript 不要で読み込めるよう .mjs とする（#87）。
// next start は .ts 設定を typescript でトランスパイルするため、devDependency を
// prune した本番イメージでは next.config.ts が読めず起動に失敗していた。
/** @type {import('next').NextConfig} */
const nextConfig = {
  assetPrefix: process.env.NEXT_PUBLIC_BASE_PATH ?? "",
};

export default nextConfig;
