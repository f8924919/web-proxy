// web-proxy 実行時リクエスト横取り Service Worker。
// 閲覧ページ（/browse?url=<target>）内で JS が動的に発行するリクエスト
// （ナビゲーションを除く全メソッド）を横取りし、同一オリジンの /api/proxy?url=...
// 経由へ振り向ける（クロスオリジン化を解消し CORS プリフライトを消す）。
// 仕様: docs/spec/features/proxy.md §Service Worker による実行時リクエスト横取り
//      docs/spec/features/proxy.md §CORS プリフライト対応
//      docs/arch/proxy.md §Service Worker
//
// 純粋ロジック（下記関数）は module.exports で公開してテストする。
// SW ランタイム配線は importScripts の有無でガードし、Node（テスト）環境では実行しない。
(function (global) {
  "use strict";

  // 登録スコープ（例: https://host/proxy/3000/）から BASE_PATH（例: /proxy/3000）を導出する。
  function deriveBasePath(scope) {
    try {
      const p = new URL(scope).pathname;
      return p === "/" ? "" : p.replace(/\/$/, "");
    } catch {
      return "";
    }
  }

  // 横取りしてはいけない自前ルートか判定する（BASE_PATH を取り除いた上で判定）。
  function isProxyOwnPath(pathname, basePath) {
    let p = pathname;
    if (basePath && p.startsWith(basePath)) {
      p = p.slice(basePath.length) || "/";
    }
    if (p === "" || p === "/") return true; // ホーム
    if (p === "/sw.js") return true;
    // 完全一致＋パス境界で判定する（ターゲット側の /browser や /api/proxyData を誤判定しない）
    if (p === "/browse" || p.startsWith("/browse/")) return true;
    if (p === "/api/proxy" || p.startsWith("/api/proxy/")) return true;
    if (p.startsWith("/_next/")) {
      // /_next/image はターゲット（Next.js 製サイト）の画像最適化エンドポイント。
      // クライアント hydration が再生成する /_next/image?url=<外部> をプロキシ自身の
      // 最適化エンドポイントに当てると外部ドメインが remotePatterns 未許可で 400 になる。
      // 自前ルートから除外し、rewriteRequestUrl のフォールバックでターゲット origin の
      // /_next/image へ振り向ける（#102。サーバー描画分の srcset 書き換えは #98）。
      // それ以外の /_next/（static チャンク・data 等）はプロキシ自身の資産として素通し。
      if (p === "/_next/image" || p.startsWith("/_next/image/")) return false;
      return true;
    }
    if (p === "/favicon.ico") return true;
    return false;
  }

  // 要求元ページ URL（/browse?url=<target>）からターゲット URL を取り出す。
  function extractTarget(pageUrl) {
    try {
      return new URL(pageUrl).searchParams.get("url");
    } catch {
      return null;
    }
  }

  // リクエスト URL を /api/proxy 経由の振り向け先へ書き換える。
  // 横取り不要（自前ルート・ターゲット不明）なら null を返す。
  function rewriteRequestUrl(requestUrl, pageUrl, swOrigin, basePath) {
    let req;
    try {
      req = new URL(requestUrl);
    } catch {
      return null;
    }

    // パス反映形式（/api/proxy/<scheme>/<host>/<path>）へ書き換える（#100）。
    // ランタイム相対 import がブラウザ上で正しく解決されるようにする。
    // proxyPath.ts の buildProxyPath と同形（SW は importScripts 不可のため自前で持つ）。
    // 仕様: docs/spec/features/proxy.md §プロキシ URL スキーム（パス反映）
    const toProxy = (absolute) => {
      const u = new URL(absolute);
      const scheme = u.protocol.replace(/:$/, "");
      return (
        basePath +
        "/api/proxy/" +
        scheme +
        "/" +
        u.host +
        u.pathname +
        u.search +
        u.hash
      );
    };

    // クロスオリジンの絶対 URL → そのまま中継
    if (req.origin !== swOrigin) {
      return toProxy(req.href);
    }

    // 同一オリジン: 自前ルートは横取りしない
    if (isProxyOwnPath(req.pathname, basePath)) {
      return null;
    }

    // 同一オリジンの非自前パス（ルート絶対パス等）→ ターゲット origin に解決
    const target = extractTarget(pageUrl);
    if (!target) return null;
    let targetOrigin;
    try {
      targetOrigin = new URL(target).origin;
    } catch {
      return null;
    }

    let path = req.pathname;
    if (basePath && path.startsWith(basePath)) {
      path = path.slice(basePath.length) || "/";
    }
    let resolved;
    try {
      resolved = new URL(path + req.search + req.hash, targetOrigin).href;
    } catch {
      return null;
    }
    return toProxy(resolved);
  }

  // ---- SW ランタイム配線（テスト環境では実行しない）----
  if (typeof importScripts === "function") {
    self.addEventListener("install", function () {
      self.skipWaiting();
    });
    self.addEventListener("activate", function (event) {
      event.waitUntil(self.clients.claim());
    });
    self.addEventListener("fetch", function (event) {
      const req = event.request;
      // ページ遷移ナビゲーション（フォーム POST 含む）はサーバー側書き換えに委ねる。
      if (req.mode === "navigate") return;

      const basePath = deriveBasePath(self.registration.scope);
      const swOrigin = self.location.origin;

      let reqUrl;
      try {
        reqUrl = new URL(req.url);
      } catch {
        return;
      }

      // 同一オリジンの自前ルートは介在しない（/api/proxy への再帰を防ぐ）
      if (
        reqUrl.origin === swOrigin &&
        isProxyOwnPath(reqUrl.pathname, basePath)
      ) {
        return;
      }

      // 非 GET を含むサブリソースを同一オリジンの /api/proxy へ振り向け、
      // クロスオリジン化を解消して CORS プリフライトを消す。
      // 仕様: docs/spec/features/proxy.md §CORS プリフライト対応
      event.respondWith(
        (async function () {
          let pageUrl = req.referrer;
          if (event.clientId) {
            const client = await self.clients.get(event.clientId);
            if (client && client.url) pageUrl = client.url;
          }
          const dest = rewriteRequestUrl(req.url, pageUrl, swOrigin, basePath);
          if (!dest) return fetch(req);

          // 振り向け先は常に同一オリジンの /api/proxy。プロキシ自身が認証プロキシ
          // （Cloudflare Access 等）の背後にある場合に備え、same-origin の Cookie
          // （CF_Authorization 等）を送る。omit だと Access が未認証とみなして
          // ログインページへ 302 し、クロスオリジンに着地して CORS で失敗する。
          // プロキシ自身のインフラ認証 cookie は非スコープのため、/api/proxy 側の
          // サイト間 Cookie アイソレーション（スコープ抽出）で上流転送から自動除外される。
          try {
            // GET/HEAD はボディなし。非 GET はメソッド・ヘッダー・ボディを保持する。
            if (req.method === "GET" || req.method === "HEAD") {
              return await fetch(dest, { credentials: "same-origin" });
            }
            const body = await req.arrayBuffer();
            return await fetch(dest, {
              method: req.method,
              headers: req.headers,
              body: body.byteLength ? body : undefined,
              credentials: "same-origin",
            });
          } catch {
            // 振り向け fetch が失敗（ネットワーク/CORS 等）しても未処理 reject に
            // しない。ネットワークエラー応答を返して respondWith を解決させる。
            return Response.error();
          }
        })()
      );
    });
  }

  // ---- テスト用エクスポート ----
  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      deriveBasePath,
      isProxyOwnPath,
      extractTarget,
      rewriteRequestUrl,
    };
  }

  void global;
})(typeof self !== "undefined" ? self : globalThis);
