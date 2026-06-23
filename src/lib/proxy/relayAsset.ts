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
import { isNullBodyStatus } from "@/lib/proxy/response";
import { assetRateLimiter } from "@/lib/proxy/rateLimit";
import { getClientIp } from "@/lib/proxy/clientIp";

// アセット中継の共通処理。両 route（パス反映形式の [...slug] と後方互換の ?url=）が
// ターゲット絶対 URL を決定したうえで本関数へ委譲する。
// 仕様: docs/spec/features/proxy.md §プロキシ URL スキーム / §CORS プリフライト対応
export async function relayAsset(
  req: NextRequest,
  targetHref: string
): Promise<Response> {
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

  // GET/HEAD は既存の許可リスト（Cookie/Authorization）を維持。
  // 非 GET は拒否リスト方式で広めにヘッダーを転送し、ボディも転送する。
  // Cookie は現ターゲット origin にスコープされた分だけを転送する（サイト間アイソレーション）。
  const isBodyMethod = req.method !== "GET" && req.method !== "HEAD";
  const headers = isBodyMethod
    ? relayRequestHeaders(req.headers, parsed.origin)
    : forwardableRequestHeaders(req.headers, parsed.origin);

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
  // Set-Cookie のスコープ鍵にはリダイレクト追従後の最終 URL の origin を用いる
  // （書き換え基準 baseUrl と揃える。#42）。
  const outHeaders = sanitizeHeaders(res.headers, new URL(finalUrl).origin);

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

    return new Response(res.body, { status: res.status, headers: outHeaders });
  } catch (err) {
    // 本文が上限超過なら 413（メモリ枯渇 DoS 対策。#134）。
    if (err instanceof BodyTooLargeError) {
      return new Response("Payload Too Large", { status: 413 });
    }
    // ボディ読取り・変換・Response 構築中の予期しない例外は 500 ではなく 502 で返す
    console.error("[proxy/asset]", err);
    return new Response("Bad Gateway", { status: 502 });
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
