import { NextRequest } from "next/server";
import { htmlUiHeaders } from "@/lib/proxy/headers";
import {
  proxyAuthConfigFromEnv,
  tokensMatch,
  buildAuthCookie,
  safeRedirectPath,
  unlockHtml,
} from "@/lib/proxy/auth";

// 共有トークン認証（#148）の解錠ルート。browseGuards が返す 401 解錠ページのフォーム
// （POST {BASE_PATH}/unlock）を受け、トークンを定数時間比較で検証する。一致すれば HttpOnly
// Cookie を発行して元の閲覧 URL へ 303 リダイレクトし、不一致なら 401 でフォームを再表示する。
// SW / 横取りシムが本ルートを /api/proxy へ書き換えないよう、isProxyOwnPath / public/sw.js に
// /unlock を自前ルートとして登録している。
// 仕様: docs/spec/features/proxy.md §認証 / 接続元許可制（任意・#148）

const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

// Location は BASE_PATH を含めない（アプリ相対）。リバースプロキシが応答 Location に prefix を
// 再付加するため（#74）。一方フォーム action 等のブラウザ送信 URL は BASE_PATH を要するため、
// unlockHtml 側で前置している。
function redirectResponse(location: string, setCookie?: string): Response {
  const headers = new Headers({ Location: location });
  if (setCookie) headers.set("Set-Cookie", setCookie);
  return new Response(null, { status: 303, headers });
}

export async function POST(req: NextRequest): Promise<Response> {
  const config = proxyAuthConfigFromEnv();
  const form = await req.formData().catch(() => null);
  const redirectRaw =
    typeof form?.get("redirect") === "string"
      ? (form.get("redirect") as string)
      : null;
  const redirect = safeRedirectPath(redirectRaw, BASE_PATH);

  // 認証無効（オープン）時は解錠の必要がないため、戻り先（既定はホーム）へ流す。
  if (config === null) return redirectResponse(redirect);

  const token =
    typeof form?.get("token") === "string"
      ? (form.get("token") as string)
      : null;

  if (tokensMatch(token, config.token)) {
    return redirectResponse(redirect, buildAuthCookie(config.token, BASE_PATH));
  }

  return new Response(unlockHtml(redirect, BASE_PATH, { error: true }), {
    status: 401,
    headers: htmlUiHeaders(),
  });
}

// 手動解錠用。?redirect= を引き継いでフォーム（200）を表示する。認証無効時は戻り先へ流す。
export function GET(req: NextRequest): Response {
  const config = proxyAuthConfigFromEnv();
  const redirect = safeRedirectPath(
    req.nextUrl.searchParams.get("redirect"),
    BASE_PATH
  );
  if (config === null) return redirectResponse(redirect);
  return new Response(unlockHtml(redirect, BASE_PATH), {
    status: 200,
    headers: htmlUiHeaders(),
  });
}
