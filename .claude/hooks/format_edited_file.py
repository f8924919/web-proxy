#!/usr/bin/env python3
"""Claude Code PostToolUse hook: 編集したソースファイルをその場で整形する。

`verify` ゲート（docs/git-workflow.md §5 step 7）のフォーマッタで最後にまとめて
整形すると、整形だけの差分が実装コミットに混ざり、検証の手戻りも増える。編集直後に
同じ整形を掛けておけばその往復が消える。

**キックオフで下の 3 定数を実プロジェクトの値へ置換する**（対応表は
`.claude/kickoff.md` §2）。置換前（`{{...}}` が残っている状態）は**何もせず通す**
ため、整形コマンドを持たないプロジェクトではそのまま放置してよい。

- 単一ファイルを受け取れるフォーマッタが前提（`prettier --write <file>` /
  `ruff format <file>` / `gofmt -w <file>` / `rustfmt <file>` など）。
- 対象は 1 つのディレクトリ配下に限定する。複数言語が混在するリポジトリでは、
  主要言語のソースだけを対象にし、残りは `verify` ゲートに委ねるのが安全
  （フォーマッタの起動子が環境依存になりやすいため）。

フォーマッタ・対象ファイルのいずれかが見つからない場合、想定外の形の入力
（dict でない JSON / `tool_input`）の場合、整形が失敗した場合も**黙って通す**
（フェイルオープン）。整形は verify ゲートでも走るため、ここでの失敗は
「早めに整形できなかった」以上の意味を持たない。

標準ライブラリのみに依存し（Python 3.9+。PEP 604 の注釈は `from __future__ import annotations` で遅延評価にしている）、Windows / macOS / Linux で動作する。
"""

# Python 3.9 でも動くよう、PEP 604（`X | None`）の注釈を遅延評価にする。
from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path

# .claude/hooks/<this>.py → リポジトリルート
REPO_ROOT = Path(__file__).resolve().parents[2]

# --- キックオフで置換する定数 -------------------------------------------------
TARGET_SUBDIR = "src"  # リポジトリ相対のディレクトリ
TARGET_SUFFIXES = {".ts", ".tsx", ".css"}
FORMAT_CMD = ["npx", "prettier", "--write"]
# -----------------------------------------------------------------------------


def _configured() -> bool:
    """3 定数がキックオフで置換済みかを返す。未置換なら何もしない。"""
    values = [TARGET_SUBDIR, *TARGET_SUFFIXES, *FORMAT_CMD]
    return all(isinstance(v, str) and v and "{{" not in v for v in values)


def _target(raw_path: str) -> Path | None:
    """整形対象なら絶対パスを返す。対象外・解決不能なら None。"""
    try:
        path = Path(raw_path).resolve()
    except (OSError, ValueError):
        return None
    if path.suffix not in TARGET_SUFFIXES or not path.is_file():
        return None
    try:
        path.relative_to(REPO_ROOT / TARGET_SUBDIR)  # 対象ディレクトリの外は触らない
    except ValueError:
        return None
    return path


def main() -> None:
    if not _configured():
        return

    try:
        hook_input = json.load(sys.stdin)
    except (json.JSONDecodeError, ValueError):
        return
    if not isinstance(hook_input, dict):
        return  # 想定外の形の入力 → 通す

    tool_input = hook_input.get("tool_input")
    raw_path = tool_input.get("file_path", "") if isinstance(tool_input, dict) else ""
    if not isinstance(raw_path, str) or not raw_path:
        return

    path = _target(raw_path)
    if path is None:
        return

    executable = shutil.which(FORMAT_CMD[0])
    if executable is None:
        return

    try:
        subprocess.run(
            [executable, *FORMAT_CMD[1:], str(path)],
            capture_output=True,
            cwd=REPO_ROOT,
            timeout=60,
        )
    except (OSError, subprocess.SubprocessError):
        return  # 整形できなくても通す（verify ゲートで拾う）


if __name__ == "__main__":
    main()
