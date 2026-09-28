#!/usr/bin/env python3
"""Claude Code PostToolUse hook: 編集したファイルをその場で整形する。

`verify` ゲート（docs/git-workflow.md §5 step 7）のフォーマッタで最後にまとめて
整形すると、整形だけの差分が実装コミットに混ざり、検証の手戻りも増える。編集直後に
同じ整形を掛けておけばその往復が消える。

**キックオフで下の 3 定数を実プロジェクトの値へ置換する**（対応表は
`.claude/kickoff.md` §2）。置換前（`{{...}}` が残っている状態）は**何もせず通す**
ため、整形コマンドを持たないプロジェクトではそのまま放置してよい。

- 単一ファイルを受け取れるフォーマッタが前提（`prettier --write <file>` /
  `ruff format <file>` / `gofmt -w <file>` / `rustfmt <file>` など）。
- **対象は、プロジェクトの format:check 系のコマンドと同じ範囲にする**。hook の対象が
  それより狭いと、範囲外（テスト・docs・直下の設定ファイルなど）を編集したときに整形されずに
  コミットされ、verify のたびに範囲外の整形差分が出る。
  - `TARGET_SUBDIRS` はリポジトリ相対のディレクトリのリスト。`"."` でリポジトリ全体。
  - `TARGET_SUFFIXES` は拡張子の集合。**空の集合（`set()`）なら拡張子で絞らず、
    フォーマッタに任せる**。フォーマッタが明示パスでも ignore を守り、担当外のファイルを
    渡されても書き換えずに通す場合だけ使う（Prettier 3 は `--ignore-unknown` を付ければそうなる）。
- **cwd はリポジトリのルートに固定する**。フォーマッタは ignore ファイルや設定をカレント
  ディレクトリ基準で探すことがあり（Prettier 3 は `.gitignore` と `.prettierignore` を cwd 基準で
  探す）、セッションの cwd がほかの場所だと ignore が効かない。
- 対象はリポジトリ内のファイルだけ（`TARGET_SUBDIRS` はリポジトリ相対で、パスは解決してから
  比べるので、`..` で抜けるパスを含めてリポジトリ外は必ず外れる）。

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
# `npm run format:check`（`prettier --check .`）と同じ範囲にする
TARGET_SUBDIRS = ["."]  # リポジトリ相対のディレクトリのリスト
TARGET_SUFFIXES: set[str] = set()  # 空 = 拡張子で絞らず Prettier の判定（ignore・担当外）に任せる
FORMAT_CMD = ["npx", "prettier", "--write", "--ignore-unknown"]
# -----------------------------------------------------------------------------


def _configured() -> bool:
    """3 定数がキックオフで置換済みかを返す。未置換なら何もしない。"""
    if not TARGET_SUBDIRS or not FORMAT_CMD:
        return False
    values = [*TARGET_SUBDIRS, *TARGET_SUFFIXES, *FORMAT_CMD]
    return all(isinstance(v, str) and v and "{{" not in v for v in values)


def _target(raw_path: str) -> Path | None:
    """整形対象なら絶対パスを返す。対象外・解決不能なら None。"""
    try:
        path = Path(raw_path).resolve()
    except (OSError, ValueError):
        return None
    if not path.is_file():
        return None
    if TARGET_SUFFIXES and path.suffix not in TARGET_SUFFIXES:
        return None
    for subdir in TARGET_SUBDIRS:
        try:
            path.relative_to((REPO_ROOT / subdir).resolve())  # 対象ディレクトリの外は触らない
        except ValueError:
            continue
        return path
    return None


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
            cwd=REPO_ROOT,  # ignore ファイル・設定を cwd 基準で探すフォーマッタのため
            timeout=60,
        )
    except (OSError, subprocess.SubprocessError):
        return  # 整形できなくても通す（verify ゲートで拾う）


if __name__ == "__main__":
    main()
