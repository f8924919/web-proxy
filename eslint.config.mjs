import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      ".next/",
      "coverage/",
      // Next.js の自動生成ファイル（手編集しない）
      "next-env.d.ts",
      // Service Worker ランタイム規約の手書き JS。TS ルールに合わせた改変は
      // 行わず、ロジックは tests/lib/proxy/sw-intercept.test.ts で検証する
      "public/sw.js",
    ],
  },
  ...tseslint.configs.recommended
);
