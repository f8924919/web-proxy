import { NextRequest } from "next/server";
import { forwardableRequestHeaders } from "@/lib/proxy/headers";
import { noUrlBrowseHtml } from "@/lib/proxy/rewrite";
import { buildBrowsePath } from "@/lib/proxy/browsePath";
import {
  relayBrowse,
  browseGuards,
  htmlResponse,
} from "@/lib/proxy/browseRelay";

// 後方互換ルート（?url= クエリ方式）。パス反映ナビ形式（/browse/<scheme>/<host>/<path>・#115）が
// 正本だが、外部リンク・ブックマーク・アドレスバー入力経由の ?url= も受理する。
// GET は閲覧ページの location をクリーンにするためパス反映 URL へ 307 リダイレクトする。
// POST はリダイレクト方式が異なるため当面クエリ方式のまま直接中継する。
// 仕様: docs/spec/features/proxy.md §ページ遷移のパス反映（#115）

export function GET(req: NextRequest) {
  const url = req.nextUrl.searchParams.get("url");

  if (!url) {
    // url 未指定はリダイレクトせず、アドレスバー付き案内ページ(200) をその場で返す。
    // 以前のホーム(${BASE_PATH}/)への 307 はリバースプロキシ配下で 404 になっていた（#74）。
    return new Response(noUrlBrowseHtml(), {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return htmlResponse("URL が正しくありません。", 400);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return htmlResponse("URL が正しくありません。", 400);
  }

  // パス反映ナビ形式へ 307 リダイレクトする。上流取得・レート制限・ループ検出は
  // リダイレクト先の [...slug] ルートで行う（ここでは二重計上しない）。
  // Location は BASE_PATH を含めない（アプリ相対）。リバースプロキシ（code-server の
  // /proxy/3000 等）は受信時に prefix を剥がす一方、応答の Location には prefix を再付加する
  // ため、BASE_PATH を含めると二重（/proxy/3000/proxy/3000/…）になる（#74/#55 と同じ理由。
  // <a href> 等のブラウザ送信 URL は逆に BASE_PATH が必要で、buildBrowsePath は BASE_PATH 付きで
  // 組み立てる）。BASE_PATH 無し環境では Location はそのまま機能する。
  return new Response(null, {
    status: 307,
    headers: { Location: buildBrowsePath(parsed.href, "") },
  });
}

// フォーム POST 送信の中継。リクエストの method / body / Content-Type をターゲットへ転送する。
// POST はクエリ方式のまま直接中継する（パス反映へのリダイレクトは行わない）。
// 仕様: docs/spec/features/proxy.md §POST 中継
export async function POST(req: NextRequest) {
  const url = req.nextUrl.searchParams.get("url");

  // POST は GET のホームリダイレクトと異なり、url 欠落・不正は 400 とする。
  if (!url) {
    return htmlResponse("URL が指定されていません。", 400);
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return htmlResponse("URL が正しくありません。", 400);
  }

  const guard = browseGuards(req, parsed);
  if (guard) return guard;

  // Cookie / Authorization に加え、Content-Type を転送して
  // urlencoded / multipart の境界情報を維持する。
  const headers: Record<string, string> = forwardableRequestHeaders(
    req.headers,
    parsed.origin
  );
  const contentType = req.headers.get("content-type");
  if (contentType) headers["content-type"] = contentType;

  return relayBrowse(parsed, {
    method: "POST",
    body: req.body,
    headers,
  });
}
