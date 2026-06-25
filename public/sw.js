// web-proxy 実行時リクエスト横取り Service Worker。
// 閲覧ページ（パス反映 /browse/<scheme>/<host>/<path>・#115。後方互換 /browse?url=<target>）内で
// JS が動的に発行するリクエスト（ナビゲーションを除く全メソッド）を横取りし、同一オリジンの
// /api/proxy/<scheme>/<host>/<path> 経由へ振り向ける（クロスオリジン化を解消し CORS プリフライトを消す）。
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
    if (p === "/unlock") return true; // 共有トークン認証の解錠ルート（#148）
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

  // 要求元ページ URL からターゲット URL を取り出す。パス反映ナビ形式
  // （/browse/<scheme>/<host>/<path>・#115）と後方互換 /browse?url=<target> の両方に対応する。
  // rewrite.ts の extractBrowseTarget と同形（SW は importScripts 不可のため自前で持つ）。
  function extractTarget(pageUrl) {
    try {
      const u = new URL(pageUrl);
      const MARKER = "/browse/";
      const idx = u.pathname.indexOf(MARKER);
      if (idx !== -1) {
        const rest = u.pathname.slice(idx + MARKER.length);
        const fs = rest.indexOf("/");
        if (fs === -1) return null;
        const scheme = rest.slice(0, fs);
        if (scheme !== "http" && scheme !== "https") return null;
        const after = rest.slice(fs + 1);
        const hs = after.indexOf("/");
        const host = hs === -1 ? after : after.slice(0, hs);
        if (!host) return null;
        const path = hs === -1 ? "" : after.slice(hs);
        return new URL(scheme + "://" + host + path + u.search).href;
      }
      return u.searchParams.get("url");
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

  // サブフレーム（iframe）ナビゲーションの src をブラウズ中継経路（/browse/<scheme>/<host>/<path>）
  // へ書き換える。rewriteRequestUrl と対称だが、出力が /api/proxy ではなく /browse である点が異なる。
  // これにより iframe はブラウズ中継経路で読み込まれ、中継・書き換え・SW 登録・シム注入がフル適用
  // され、iframe 内部の相対 URL も正しく解決される。横取り不要（自前ルート・非 http(s)・ターゲット
  // 不明）なら null を返す。仕様: docs/spec/features/proxy.md §サブフレーム（iframe）ナビゲーションの横取り（#162）
  function rewriteSubframeNavUrl(requestUrl, pageUrl, swOrigin, basePath) {
    let req;
    try {
      req = new URL(requestUrl);
    } catch {
      return null;
    }

    // 非 http(s)（about:blank・data:・blob: 等）は素通し（スキーム破壊を防ぐ）。
    if (req.protocol !== "http:" && req.protocol !== "https:") return null;

    const toBrowse = (absolute) => {
      const u = new URL(absolute);
      const scheme = u.protocol.replace(/:$/, "");
      return (
        basePath +
        "/browse/" +
        scheme +
        "/" +
        u.host +
        u.pathname +
        u.search +
        u.hash
      );
    };

    // クロスオリジンの絶対 URL → そのまま /browse へ
    if (req.origin !== swOrigin) {
      return toBrowse(req.href);
    }

    // 同一オリジン: 自前ルートは横取りしない（/browse へのリダイレクト再帰を防ぐ）
    if (isProxyOwnPath(req.pathname, basePath)) {
      return null;
    }

    // 同一オリジンの非自前パス（root 相対等）→ ページのターゲット origin に解決
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
    return toBrowse(resolved);
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
      // ナビゲーション（mode === "navigate"）の扱い。
      if (req.mode === "navigate") {
        // トップレベル遷移（destination=document）はサーバー側書き換え・クライアント横取り・
        // フォーム送信に委ねて素通し。サブフレーム（iframe/frame）の navigate だけは、
        // ランタイム動的生成 iframe の root 相対/絶対 src がプロキシ自身の origin に 404 着地
        // するのを防ぐため、ターゲット origin 基準の /browse へ 302 リダイレクトする（#162）。
        if (req.destination !== "iframe" && req.destination !== "frame") return;

        const navBasePath = deriveBasePath(self.registration.scope);
        const navSwOrigin = self.location.origin;
        let navUrl;
        try {
          navUrl = new URL(req.url);
        } catch {
          return;
        }
        // 既に自前ルート（/browse 等）を指すサブフレーム遷移は素通し（リダイレクト再帰防止）。
        if (
          navUrl.origin === navSwOrigin &&
          isProxyOwnPath(navUrl.pathname, navBasePath)
        ) {
          return;
        }

        event.respondWith(
          (async function () {
            let pageUrl = req.referrer;
            if (event.clientId) {
              const client = await self.clients.get(event.clientId);
              if (client && client.url) pageUrl = client.url;
            }
            const dest = rewriteSubframeNavUrl(
              req.url,
              pageUrl,
              navSwOrigin,
              navBasePath
            );
            if (!dest) return fetch(req);
            // dest はプロキシ origin 上の相対パス。Response.redirect は絶対 URL を要求する
            // ため、SW の origin を基準に絶対化して標準準拠の Location を返す。
            return Response.redirect(new URL(dest, navSwOrigin).href, 302);
          })()
        );
        return;
      }

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
      rewriteSubframeNavUrl,
    };
  }

  void global;
})(typeof self !== "undefined" ? self : globalThis);
