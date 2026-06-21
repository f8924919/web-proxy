// ヒューリスティック自動ティア昇格（崩れ/チャレンジ検出）。
// 中継ティア（proxyFetch）の初回応答が「崩れている / チャレンジが挟まっている」と判定された
// 場合に、ブラウザティア（browserFetch）へ自動昇格して再取得すべきかを判定する。明示 allowlist
// （shouldUseBrowser）を補助するヒューリスティックで、ティア判定本体とは独立したモジュール。
// 仕様: docs/spec/features/proxy.md §ヒューリスティック自動ティア昇格（崩れ/チャレンジ検出）
// 対応 Issue: #70

// ===== 純粋関数（テスト対象） =====

// PROXY_BROWSER_AUTO_PROMOTE を解釈する。true / 1 / on（大文字小文字無視）で有効、既定は無効。
export function autoPromoteEnabledFromEnv(
  env: Record<string, string | undefined> = process.env
): boolean {
  const raw = env.PROXY_BROWSER_AUTO_PROMOTE?.trim().toLowerCase();
  return raw === "true" || raw === "1" || raw === "on";
}

// チャレンジ / bot 判定インタースティシャルを示す代表的なマーカー（小文字化した本文で照合）。
const CHALLENGE_MARKERS = [
  "enable javascript",
  "enablejs",
  "checking your browser",
  "recaptcha",
  "cf-browser-verification",
  "/cdn-cgi/challenge",
];

// noscript 外の可視テキストがこの文字数未満なら「noscript 主体」とみなす。
const NOSCRIPT_DOMINANT_MAX_TEXT = 64;

// script / style / noscript の各要素（内容ごと）とタグを除いた可視テキストを抽出し、
// 連続空白を 1 つに畳んでトリムした文字列を返す。
function visibleTextOutsideNoscript(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// 初回（中継ティア）応答から、ブラウザティアへ昇格すべき崩れ/チャレンジ兆候を検出する。
// text/html 応答のみ対象。チャレンジ語句 / <noscript> 主体 / 403・503 のいずれかで true。
// 空 body 単独は誤検知が多いため判定材料にしない。非 HTML は常に false（安全側）。
export function shouldPromoteToBrowser(
  html: string,
  status: number,
  contentType: string
): boolean {
  if (!contentType.toLowerCase().includes("text/html")) return false;

  // bot ブロック相当ステータス。
  if (status === 403 || status === 503) return true;

  const lower = html.toLowerCase();

  // チャレンジ / bot 判定マーカー。
  if (CHALLENGE_MARKERS.some((m) => lower.includes(m))) return true;

  // <noscript> 主体（JS 無効向け案内が本文の主要部）。
  if (
    /<noscript[\s>]/i.test(html) &&
    visibleTextOutsideNoscript(html).length < NOSCRIPT_DOMINANT_MAX_TEXT
  ) {
    return true;
  }

  return false;
}

// ===== 再昇格抑止（インメモリ状態・テスト対象） =====

const DEFAULT_WINDOW_MS = 60_000;

// 同一 URL（host+path 単位・クエリ無視）の自動昇格を短時間ウィンドウ内で 1 回に制限し、
// proxyFetch → browserFetch の二重取得コストの無限ループを防ぐ。loopGuard / rateLimit と同じ
// インメモリ・スライディングウィンドウ方式（プロセス再起動でリセット）。
export class PromotionGuard {
  // Map<`${host}${pathname}`, タイムスタンプ配列（直近 windowMs 分）>
  private store = new Map<string, number[]>();

  constructor(private readonly windowMs: number = DEFAULT_WINDOW_MS) {}

  // 再昇格可能なら今回の昇格を記録して true を返す。ウィンドウ内に既に昇格済みなら
  // 抑止して false を返す。キーはクエリを無視した host+path 単位
  // （sei 等の毎回変わるクエリで抑止が外れないようにする）。
  tryPromote(target: URL): boolean {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    const key = `${target.host}${target.pathname}`;

    const recent = (this.store.get(key) ?? []).filter((t) => t > cutoff);
    if (recent.length > 0) {
      this.store.set(key, recent);
      return false;
    }
    recent.push(now);
    this.store.set(key, recent);
    return true;
  }
}

// /browse（GET）用の共有インスタンス。
export const promotionGuard = new PromotionGuard();
