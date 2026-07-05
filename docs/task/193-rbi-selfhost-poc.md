# #193 調査スパイク: RBI ハイブリッド段階導入の自前ホスト PoC（Kasm / Neko・IME キル基準）

- **Issue**: [#193](https://github.com/f8924919/web-proxy/issues/193)
- **ステータス**: 未着手
- **種別**: 調査スパイク（PoC 検証。本番実装はスコープ外）
- **関連**: 調査結論 #72（[archive/72-rbi-isolation-spike.md](archive/72-rbi-isolation-spike.md)）/ ブラウザ基盤 #71 / アンチボット #73

## 概要

#72 の採用判断（ハイブリッド段階導入）を受け、本番想定形態である自前ホスト（Kasm Workspaces Community / Neko）で RBI 経路の PoC を行う。

## フェーズ（Issue の受け入れ条件に対応）

1. **IME キル基準**: Kasm / Neko を最小構成で起動し、日本語 IME 入力の忠実度を手動評価。no-go なら以降を打ち切り。
2. **資源実測**: go の方式で同時 10 セッション規模の帯域・RAM・CPU を実測し #72 試算と突き合わせ。
3. **振り分けロジック**: `shouldUseBrowser` / `shouldPromoteToBrowser` を再利用した RBI フォールバック判定の設計案（モック接続まで）。

成果物は PoC 結果と「本採用に進むか / 対象サイト範囲 / 必要インフラ」の判断材料（比較表つき）を本メモへ記録する。
