#!/usr/bin/env python3
"""Claude Code PreToolUse hook: main ブランチ上の git commit / git push をブロックする。

「main で直接コミットしない」（docs/git-workflow.md §1）のクライアント側強制。
サーバー側の最後の砦はホスティングの branch protection が担うため、本 hook は
早期警告に徹し、判定に迷うケースはすべてフェイルオープン（通す）に倒す:

- stdin の JSON パース失敗・想定外の形（dict でない JSON / `tool_input`）・
  git コマンド失敗（リポジトリ外・detached HEAD 等）→ 通す
- 検出は「`&&` / `;` / `|` / 改行で分割した各セグメントのサブコマンド位置」での
  git commit / git push 一致のみ。`git -c k=v commit` のようなオプション挟み込みや
  文字列内の擦り抜けは追わない（誤ブロック回避を優先。docs/git-workflow.md §1）。
- ただし**リモートブランチの削除のみ**の push（`git push --delete` / `-d`、または
  リモート名を除く refspec がすべて `:branch` 形）は `main` 上でも通す。マージ後のブランチ削除は `main` へ戻ってから
  行う正規の手順（docs/git-workflow.md §5 step 9・/finish-task）であり、これを
  塞ぐと運用が回らない。削除は `main` の履歴を変更しないため、本 hook の目的
  （main への直接の変更を防ぐ）から外れる。

ブランチ判定は cwd を起点にした実効ディレクトリに対して行う:

- 複合コマンド内の `cd <path>` セグメントを追跡し、後続セグメントは移動先で判定する
- git のグローバルオプション `-C <path>`（複数指定は累積）を解決して判定する
- `--git-dir` / `--work-tree`・クォート付きパス（スペース含む）・パス解決不能は
  一律フェイルオープン（通す）

ブロック時は permissionDecision: deny と理由を JSON で stdout に返す。
標準ライブラリのみに依存し（Python 3.9+。PEP 604 の注釈は `from __future__ import annotations` で遅延評価にしている）、Windows / macOS / Linux で動作する。
"""

# Python 3.9 でも動くよう、PEP 604（`X | None`）の注釈を遅延評価にする。
from __future__ import annotations

import json
import os
import re
import subprocess
import sys

BLOCKED_SUBCOMMANDS = {"commit", "push"}
SEGMENT_SPLIT = re.compile(r"&&|\|\||;|\||\n")


def _current_branch(cwd: str | None) -> str | None:
    """カレントブランチ名を返す。解決できない場合は None（フェイルオープン）。"""
    try:
        result = subprocess.run(
            ["git", "symbolic-ref", "--short", "HEAD"],
            capture_output=True,
            text=True,
            cwd=cwd or None,
            timeout=10,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if result.returncode != 0:
        return None
    return result.stdout.strip() or None


def _resolve_dir(base: str | None, path: str) -> str | None:
    """path を base 起点で解決する。相対パスで base 不明なら None（通す）。"""
    if os.path.isabs(path):
        return os.path.normpath(path)
    if base is None:
        return None
    return os.path.normpath(os.path.join(base, path))


def _git_subcommand(tokens: list[str]) -> tuple[str, list[str], list[str]] | None:
    """git セグメントのサブコマンド・`-C` パス列・サブコマンド以降の引数を返す。

    判定不能なら None。
    `-C <path>` は引数を取るグローバルオプションとして読み飛ばしつつ収集する。
    `--git-dir` / `--work-tree`（空白形・`=` 形とも）はスコープ外のため None
    （フェイルオープン）。その他のオプションは従来どおり引数なしとして読み飛ばす。
    """
    c_paths: list[str] = []
    i = 1
    while i < len(tokens):
        token = tokens[i]
        if token == "-C":
            if i + 1 >= len(tokens):
                return None  # 引数欠落 → フェイルオープン
            c_paths.append(tokens[i + 1])
            i += 2
            continue
        if token.startswith("--git-dir") or token.startswith("--work-tree"):
            return None  # 別リポジトリ指定のうちスコープ外の形 → フェイルオープン
        if token.startswith("-"):
            i += 1
            continue
        return token, c_paths, tokens[i + 1 :]
    return None


def _is_branch_deletion(args: list[str]) -> bool:
    """`git push` の引数が**リモートブランチの削除のみ**かを判定する。

    `--delete` / `-d` を含むか、リモート名を除く refspec が**すべて** `:branch` 形
    （削除 refspec）のときだけ削除とみなす。削除は main の履歴を変更しないため
    main 上でもブロックしない（docs/git-workflow.md §1・§5 step 9）。

    `git push origin main :old` のような**削除と通常 push の混在**は削除とみなさない。
    削除 refspec が 1 つでもあれば通す判定にすると、main の履歴を変更する push が
    擦り抜けるため。
    """
    if any(arg in ("--delete", "-d") for arg in args):
        return True
    positional = [arg for arg in args if not arg.startswith("-")]
    # 先頭がリモート名（`git push origin :old`）か、省略形（`git push :old`）かを見分ける
    refspecs = positional if positional and positional[0].startswith(":") else positional[1:]
    return bool(refspecs) and all(arg.startswith(":") for arg in refspecs)


def _blocked_violation(command: str, base_cwd: str | None) -> str | None:
    """main 上で禁止する git サブコマンドが実行されるなら、そのサブコマンドを返す。

    セグメントを順に走査し、`cd <path>` で実効ディレクトリを更新する。
    cwd が None のまま（hook 入力に cwd が無い）の場合は従来どおり
    プロセス cwd での判定に落ちる。cd の解決に失敗した以降は判定不能として
    git セグメントを通す（フェイルオープン）。ただし `-C` の絶対パスなど
    実効ディレクトリに依存せず解決できる場合は判定する。
    """
    cwd = base_cwd
    unknown = False
    for segment in SEGMENT_SPLIT.split(command):
        tokens = segment.strip().split()
        if not tokens:
            continue
        if tokens[0] == "cd":
            if len(tokens) == 2:
                cwd = _resolve_dir(None if unknown else cwd, tokens[1])
                unknown = cwd is None
            else:
                # 引数なし cd（ホーム移動）やクォート割れ（スペース含むパス）は
                # 移動先を解決しない → 以降は判定不能
                cwd, unknown = None, True
            continue
        if tokens[0] != "git":
            continue
        parsed = _git_subcommand(tokens)
        if parsed is None:
            continue
        subcommand, c_paths, args = parsed
        if subcommand not in BLOCKED_SUBCOMMANDS:
            continue
        if subcommand == "push" and _is_branch_deletion(args):
            continue  # マージ済みブランチの削除は main 上でも通す
        target = None if unknown else cwd
        resolvable = True
        for path in c_paths:
            target = _resolve_dir(target, path)
            if target is None:
                resolvable = False
                break
        if not resolvable or (unknown and not c_paths):
            continue
        if _current_branch(target) == "main":
            return subcommand
    return None


def main() -> None:
    try:
        hook_input = json.load(sys.stdin)
    except (json.JSONDecodeError, ValueError):
        return
    if not isinstance(hook_input, dict):
        return  # 想定外の形の入力 → 通す

    tool_input = hook_input.get("tool_input")
    command = tool_input.get("command", "") if isinstance(tool_input, dict) else ""
    if not isinstance(command, str) or not command:
        return

    cwd = hook_input.get("cwd")
    subcommand = _blocked_violation(command, cwd if isinstance(cwd, str) else None)
    if subcommand is None:
        return

    reason = (
        f"main ブランチ上での `git {subcommand}` はブロックされました"
        "（docs/git-workflow.md §1: main で直接コミットしない）。"
        "feature/bugfix 等のブランチを main から切って作業してください。"
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
