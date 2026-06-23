// enablejs（Google 検索の「enable JavaScript」インタースティシャル等）のように、
// JS が現在ページへ毎回異なるクエリ（?…&sei=<毎回変化>）を付けて自分自身へ再ナビゲーションし
// 続ける無限ループを検出する。各遷移は Service Worker を素通しして /browse を叩くため、
// 放置すると無限リロード → レート制限（60 req/分）で 429 に着地してしまう。
// 仕様: docs/spec/features/proxy.md §ナビゲーションループの検出（enablejs 対策）

const DEFAULT_WINDOW_MS = 10_000;
const DEFAULT_MAX_NAVIGATIONS = 6;

export class NavigationLoopGuard {
  // Map<`${ip}\n${host}${pathname}`, タイムスタンプ配列（直近 windowMs 分）>
  private store = new Map<string, number[]>();
  // 前回 eviction を実行した時刻。毎リクエストの全走査を避け windowMs ごとに間引く。
  private lastEviction = 0;

  constructor(
    private readonly maxNavigations: number = DEFAULT_MAX_NAVIGATIONS,
    private readonly windowMs: number = DEFAULT_WINDOW_MS
  ) {}

  // 今回の遷移を記録し、同一キーへの遷移がウィンドウ内で閾値を超えたら true（ループ）を返す。
  // キーはクエリを無視した host+path 単位（sei 等が毎回変わってもループを同一視するため）。
  check(ip: string, target: URL): boolean {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    this.evictExpired(cutoff, now);

    const key = `${ip}\n${target.host}${target.pathname}`;
    const timestamps = (this.store.get(key) ?? []).filter((t) => t > cutoff);
    timestamps.push(now);
    this.store.set(key, timestamps);

    return timestamps.length > this.maxNavigations;
  }

  // 全タイムスタンプがウィンドウ外になった空エントリを削除し、偽装 IP 等での store 肥大を
  // 防ぐ（#132）。前回 eviction から windowMs 未満なら走査を省く。
  private evictExpired(cutoff: number, now: number): void {
    if (now - this.lastEviction < this.windowMs) return;
    this.lastEviction = now;
    for (const [key, timestamps] of this.store) {
      if (timestamps.every((t) => t <= cutoff)) this.store.delete(key);
    }
  }

  // テスト用: 現在のエントリ数。
  get size(): number {
    return this.store.size;
  }
}

// /browse（ページ遷移）用の共有インスタンス。閾値はレート制限（60 req/分）より十分小さく取り、
// 429 に達する前に発火させる。
export const navigationLoopGuard = new NavigationLoopGuard();

// ループ検出時に返す静的案内ページ。ターゲットの中継 HTML（ループを駆動する JS を含む）の
// 代わりにこれを返すことで、当該タブの再ナビゲーション JS が置き換わりループが停止する。
// meta refresh・自動 location 遷移・script を一切含めない（ループ再発を防ぐため）。
export function loopGuidanceHtml(): string {
  const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
  return `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8"><title>表示できません</title></head>
<body style="font-family:sans-serif;padding:2rem;line-height:1.7">
<h2>このページは表示できません</h2>
<p>このサイトはブラウザ上で繰り返し自動的に再読み込みを行うため、プロキシ経由では表示できません（Google 検索の「JavaScript を有効にしてください」画面など、JavaScript チャレンジを要求するサイトで発生します）。</p>
<p>無限リロードを避けるため、自動転送を停止しました。</p>
<a href="${basePath}/">ホームへ戻る</a>
</body></html>`;
}
