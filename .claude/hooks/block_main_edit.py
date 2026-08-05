#!/usr/bin/env python3
"""Claude Code PreToolUse hook: main ブランチ上でのリポジトリ内ファイル編集をブロックする。

「main で直接作業しない」（docs/git-workflow.md §1）を**編集の時点**で効かせる。
`block_main_commit.py` は commit / push を止めるが、そこに至るまでの編集は
素通りするため、ブランチを切り忘れたことに気付くのが commit 直前になっていた。

判定に迷うケースはすべてフェイルオープン（通す）に倒す:

- stdin の JSON パース失敗・想定外の形（dict でない JSON / `tool_input`）・
  対象パス欠落・パス解決失敗 → 通す
- git コマンド失敗（リポジトリ外・detached HEAD 等）→ 通す
- **リポジトリ外のファイルは対象外**（Claude Code のメモリなど、リポジトリと
  無関係の書き込みを巻き込まないため）

ブロック時は permissionDecision: deny と理由を JSON で stdout に返す。
標準ライブラリのみに依存し（Python 3.9+。PEP 604 の注釈は `from __future__ import annotations` で遅延評価にしている）、Windows / macOS / Linux で動作する。
"""

# Python 3.9 でも動くよう、PEP 604（`X | None`）の注釈を遅延評価にする。
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]


def _on_main() -> bool:
    """リポジトリのカレントブランチが main かを返す。解決不能なら False（通す）。"""
    try:
        result = subprocess.run(
            ["git", "symbolic-ref", "--short", "HEAD"],
            capture_output=True,
            text=True,
            cwd=REPO_ROOT,
            timeout=10,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    if result.returncode != 0:
        return False
    return result.stdout.strip() == "main"


def _inside_repo(raw_path: str) -> bool:
    """対象ファイルがリポジトリ内かを返す。解決できなければ False（通す）。"""
    try:
        Path(raw_path).resolve().relative_to(REPO_ROOT)
    except (OSError, ValueError):
        return False
    return True


def _edited_path(tool_input: object) -> str:
    """編集対象のパスを返す。解決できなければ空文字（通す）。

    Edit / Write は `file_path`、NotebookEdit は `notebook_path` を使うため
    両方を見る（matcher に NotebookEdit を入れても `file_path` しか見なければ
    対象パスが空になり素通りする）。
    """
    if not isinstance(tool_input, dict):
        return ""
    for key in ("file_path", "notebook_path"):
        value = tool_input.get(key, "")
        if isinstance(value, str) and value:
            return value
    return ""


def main() -> None:
    try:
        hook_input = json.load(sys.stdin)
    except (json.JSONDecodeError, ValueError):
        return
    if not isinstance(hook_input, dict):
        return  # 想定外の形の入力 → 通す

    raw_path = _edited_path(hook_input.get("tool_input"))
    if not raw_path:
        return

    if not _inside_repo(raw_path) or not _on_main():
        return

    reason = (
        "main ブランチ上でのリポジトリ内ファイルの編集はブロックされました"
        "（docs/git-workflow.md §1: main で直接作業しない）。"
        "先に main から作業ブランチ（feature/ bugfix/ refactor/ docs/ chore/ 等）を"
        "切ってから編集してください。"
    )
    # Windows のコンソールエンコーディング（cp932 等）で化けないよう
    # ensure_ascii（既定）で ASCII セーフに出力する
    print(
        json.dumps(
            {
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "deny",
                    "permissionDecisionReason": reason,
                }
            }
        )
    )


if __name__ == "__main__":
    main()
