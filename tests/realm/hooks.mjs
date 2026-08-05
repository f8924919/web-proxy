// `dns/promises` を dns-stub.mjs へ差し替えるモジュール解決フック（テスト方針 §1.2）。
// 本番コードに seam を入れずに依存を差し替えるための唯一の手段として使う。
// register() は register.mjs 側で行い、本ファイルはフック本体だけを提供する。

const STUB = new URL("./dns-stub.mjs", import.meta.url).href;

export async function resolve(specifier, context, next) {
  if (specifier === "dns/promises" || specifier === "node:dns/promises") {
    return { url: STUB, shortCircuit: true };
  }
  return next(specifier, context);
}
