import { NextRequest } from "next/server";
import {
  proxyFetch,
  SsrfBlockedError,
  BodyTooLargeError,
  readTextWithLimit,
  maxBufferBytesFromEnv,
} from "@/lib/proxy/fetch";
import { rewriteCss } from "@/lib/proxy/rewrite";
import {
  sanitizeHeaders,
  forwardableRequestHeaders,
  relayRequestHeaders,
  buildCorsPreflightHeaders,
  allowedCorsOrigin,
} from "@/lib/proxy/headers";
import {
  cookieJar,
  resolveSession,
  buildSessionCookie,
  setCookiesFromHeaders,
} from "@/lib/proxy/cookieJar";
import { isNullBodyStatus } from "@/lib/proxy/response";
import { assetRateLimiter } from "@/lib/proxy/rateLimit";
import { isAllowedTarget, allowedPortsFromEnv } from "@/lib/proxy/targetPolicy";
import {
  relayConcurrencyLimiter,
  ConcurrencyLimitExceededError,
} from "@/lib/proxy/concurrency";
import { getClientIp } from "@/lib/proxy/clientIp";
import {
  proxyAuthConfigFromEnv,
  isAuthorized,
  AUTH_HEADER_NAME,
} from "@/lib/proxy/auth";
import { logError } from "@/lib/logger";

const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

// アセット中継の共通処理。両 route（パス反映形式の [...slug] と後方互換の ?url=）が
// ターゲット絶対 URL を決定したうえで本関数へ委譲する。
// 仕様: docs/spec/features/proxy.md §プロキシ URL スキーム / §CORS プリフライト対応
export async function relayAsset(
  req: NextRequest,
  targetHref: string
): Promise<Response> {
  // 任意の共有トークン認証（#148）。有効かつ未認証ならアセットは HTML フォームではなく
  // 401（プレーン）で弾く。通常はページ自体が先に 401 で止まるため、ここに来るのは Cookie
  // 欠落時に限られる。レート制限・同時接続スロットを消費する前に検査する。
  if (
    !isAuthorized(
      req.headers.get(AUTH_HEADER_NAME),
      req.headers.get("cookie"),
      proxyAuthConfigFromEnv()
    )
  ) {
    return new Response("Unauthorized", { status: 401 });
  }

  let parsed: URL;
  try {
    parsed = new URL(targetHref);
  } catch {
    return new Response("Bad Request", { status: 400 });
  }

  const ip = getClientIp(req.headers);
  try {
    assetRateLimiter.check(ip);
  } catch {
    return new Response("Too Many Requests", { status: 429 });
  }

  // 中継先スキーム・ポートの制限（オープンプロキシ乱用対策・#133）。非 http(s)・許可外
  // ポート（既定 80/443・PROXY_ALLOWED_PORTS で追加）は中継せず 403 を返す。
  if (!isAllowedTarget(parsed, allowedPortsFromEnv())) {
    return new Response("Forbidden", { status: 403 });
  }

  // 同時接続数の制限（#133）。スロットを確保し、レスポンス構築後に finally で解放する
  // （ストリーム透過本文の転送中は計上しない）。グローバル飽和は 503・IP 過剰並列は 429。
  let release: () => void;
  try {
    release = relayConcurrencyLimiter.acquire(ip);
  } catch (err) {
    if (err instanceof ConcurrencyLimitExceededError) {
      return err.scope === "global"
        ? new Response("Service Unavailable", { status: 503 })
        : new Response("Too Many Requests", { status: 429 });
    }
    throw err;
  }

  try {
    // Cookie はブラウザ受信分を使わず、__pxy_sid セッション × ターゲット origin で jar から
    // 復元した分だけを上流へ転送する（#151 Phase 1。サイト間アイソレーション）。
    const session = resolveSession(req.headers.get("cookie"));
    const jarCookie = cookieJar.cookieHeader(session.id, parsed.origin);
    // GET/HEAD は既存の許可リスト（Cookie/Authorization）を維持。
    // 非 GET は拒否リスト方式で広めにヘッダーを転送し、ボディも転送する。
    const isBodyMethod = req.method !== "GET" && req.method !== "HEAD";
    const headers = isBodyMethod
      ? relayRequestHeaders(req.headers, parsed.origin, jarCookie)
      : forwardableRequestHeaders(req.headers, parsed.origin, jarCookie);

    let res: Response;
    let finalUrl: string;
    try {
      ({ response: res, finalUrl } = await proxyFetch(parsed.href, {
        method: req.method,
        body: isBodyMethod ? req.body : undefined,
        headers,
      }));
    } catch (err) {
      if (err instanceof SsrfBlockedError) {
        return new Response("Forbidden", { status: 403 });
      }
      return new Response("Bad Gateway", { status: 502 });
    }

    const contentType = res.headers.get("content-type") ?? "";
    // 中継 Cookie はブラウザへ返さず、リダイレクト追従後の最終 URL の origin（書き換え基準
    // baseUrl と揃える。#42）をキーに jar へ格納する（#151 Phase 1）。新規セッションなら
    // __pxy_sid を発行する。
    cookieJar.store(
      session.id,
      new URL(finalUrl).origin,
      setCookiesFromHeaders(res.headers)
    );
    const outHeaders = sanitizeHeaders(res.headers);
    if (session.isNew) {
      outHeaders.append(
        "Set-Cookie",
        buildSessionCookie(session.id, BASE_PATH)
      );
    }

    // 要求 Origin が自プロキシと同一オリジンの場合のみ CORS 許可ヘッダーを付与する。
    // 第三者クロスオリジンへは無検証エコー＋Allow-Credentials を返さない（#27）。
    // 同一オリジンのアセット中継には Origin が付かないため影響しない。
    const allowOrigin = allowedCorsOrigin(
      req.headers.get("origin"),
      req.headers.get("host")
    );
    if (allowOrigin) {
      outHeaders.set("Access-Control-Allow-Origin", allowOrigin);
      outHeaders.set("Access-Control-Allow-Credentials", "true");
      outHeaders.append("Vary", "Origin");
    }

    try {
      // 204/304 などボディを持てないステータスはボディを null にして中継する
      // （ボディ付きで Response を構築すると例外になり 500 クラッシュするため）。
      if (isNullBodyStatus(res.status)) {
        return new Response(null, { status: res.status, headers: outHeaders });
      }

      if (contentType.includes("text/css")) {
        // 書き換えのため CSS を全量バッファするが、巨大レスポンスによる OOM を防ぐため
        // サイズ上限を課す（超過は BodyTooLargeError → 413。#134）。
        const css = await readTextWithLimit(res, maxBufferBytesFromEnv());
        // baseUrl はリダイレクト追従後の最終 URL を用いる（#42）。
        const rewritten = rewriteCss(css, finalUrl);
        outHeaders.set("Content-Type", "text/css; charset=utf-8");
        return new Response(rewritten, {
          status: res.status,
          headers: outHeaders,
        });
      }

      return new Response(res.body, {
        status: res.status,
        headers: outHeaders,
      });
    } catch (err) {
      // 本文が上限超過なら 413（メモリ枯渇 DoS 対策。#134）。
      if (err instanceof BodyTooLargeError) {
        return new Response("Payload Too Large", { status: 413 });
      }
      // ボディ読取り・変換・Response 構築中の予期しない例外は 500 ではなく 502 で返す
      logError("[proxy/asset]", err);
      return new Response("Bad Gateway", { status: 502 });
    }
  } finally {
    // 上流取得〜レスポンス構築までを 1 スロットとして計上し、ここで解放する（#133）。
    release();
  }
}

// CORS プリフライト（防御的）。通常は SW の同一オリジン化でプリフライト自体が
// 発生しないが、真のクロスオリジン OPTIONS にも応答できるようにする。
export function proxyOptions(req: NextRequest): Response {
  const allowOrigin = allowedCorsOrigin(
    req.headers.get("origin"),
    req.headers.get("host")
  );
  const headers = buildCorsPreflightHeaders(
    allowOrigin,
    req.headers.get("access-control-request-headers")
  );
  return new Response(null, { status: 204, headers });
}
