#!/usr/bin/env python3
"""Claude Code SessionStart hook: 未完了タスクをセッション冒頭に注入する。

CLAUDE.md の「セッション開始時に docs/task/index.md を確認する」運用の機構化。
プロンプトの指示だけだと (1) 確認自体が飛ばされうる (2) 毎回ファイル全体を
読むコストがかかる、の 2 点が問題だったため、**必要な表だけ**を additionalContext
として注入する（docs/task/index.md の運用注記も参照）。

抽出するのは docs/task/index.md の 2 つの表:

- `## タスク` — タスクメモ (`docs/task/{slug}.md`) を持つ進行中・未着手のタスク
- `## 起票済み・未着手の Issue` — メモをまだ作っていない未着手の Issue

判定に迷うケース（ファイル欠落・見出しの改名・パース失敗）は**何も注入せず
通す**（フェイルオープン）。注入が無くても CLAUDE.md の指示で従来どおり
index.md を読めばよく、hook の不調でセッションを止めない。

標準ライブラリのみに依存し（Python 3.9+。PEP 604 の注釈は `from __future__ import annotations` で遅延評価にしている）、Windows / macOS / Linux で動作する。
"""

# Python 3.9 でも動くよう、PEP 604（`X | None`）の注釈を遅延評価にする。
from __future__ import annotations

import json
import sys
from pathlib import Path

# .claude/hooks/<this>.py → リポジトリルート
REPO_ROOT = Path(__file__).resolve().parents[2]
TASK_INDEX = REPO_ROOT / "docs" / "task" / "index.md"

SECTIONS = {
    "## タスク": "タスクメモを持つタスク",
    "## 起票済み・未着手の Issue": "起票済み・未着手の Issue",
}
EMPTY_MARKER = "ありません"


def _table_rows(lines: list[str]) -> list[list[str]]:
    """表の本文行（見出し行・区切り行を除く）をセルのリストとして返す。"""
    rows: list[list[str]] = []
    for line in lines:
        stripped = line.strip()
        if not stripped.startswith("|"):
            continue
        cells = [cell.strip() for cell in stripped.strip("|").split("|")]
        if not cells or all(set(cell) <= {"-", ":"} for cell in cells if cell):
            continue  # 区切り行
        rows.append(cells)
    return rows[1:] if rows else []  # 先頭は見出し行


def _sections(text: str) -> dict[str, list[str]]:
    """H2 見出しごとに行を束ねる。HTML コメント（記入例）内は無視する。"""
    grouped: dict[str, list[str]] = {}
    current: str | None = None
    in_comment = False
    for line in text.splitlines():
        if in_comment:
            in_comment = "-->" not in line
            continue
        if line.lstrip().startswith("<!--"):
            in_comment = "-->" not in line
            continue
        if line.startswith("## "):
            current = line.strip()
            grouped[current] = []
        elif current is not None:
            grouped[current].append(line)
    return grouped


def _format(rows: list[list[str]]) -> list[str]:
    """表の行を箇条書きにする。空表のプレースホルダ行は「なし」に畳む。"""
    if not rows:
        return ["- （表が空）"]
    if len(rows) == 1 and EMPTY_MARKER in rows[0][0]:
        return ["- なし"]
    return ["- " + " / ".join(cell for cell in row[:3] if cell and cell != "—") for row in rows]


def main() -> None:
    try:
        json.load(sys.stdin)  # 入力は使わないが、読み切ってから処理する
    except (json.JSONDecodeError, ValueError):
        pass

    try:
        grouped = _sections(TASK_INDEX.read_text(encoding="utf-8"))
    except OSError:
        return  # index.md が無い → 何も注入しない

    blocks: list[str] = []
    for heading, label in SECTIONS.items():
        if heading not in grouped:
            continue
        blocks.append(f"**{label}**")
        blocks.extend(_format(_table_rows(grouped[heading])))
        blocks.append("")

    if not blocks:
        return  # 見出しが変わった等 → 何も注入しない

    context = "\n".join(
        [
            "## 未完了タスク（docs/task/index.md からの自動注入）",
            "",
            *blocks,
            "CLAUDE.md のタスク管理ルールに従い、未着手 / 進行中のものがあれば"
            "**対応するかをユーザーに尋ねること**。詳細・着手時の申し送りは "
            "docs/task/index.md と docs/task/archive/index.md を参照。",
        ]
    )

    print(
        json.dumps(
            {
                "hookSpecificOutput": {
                    "hookEventName": "SessionStart",
                    "additionalContext": context,
                }
            }
        )
    )


if __name__ == "__main__":
    main()
