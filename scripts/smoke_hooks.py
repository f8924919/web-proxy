#!/usr/bin/env python3
"""`.claude/hooks/` の main 保護 hook のスモーク（言語非依存）。

hooks はプロンプトではなく機構で効かせるものなので、壊れても気付きにくい
（「matcher に登録したので効いているはず」が実際は素通り、という不具合が
実際に起きた）。本スクリプトは hook を **stdin JSON で直接実行**して、
ブロック / 通過の分岐が期待どおりかを確認する。

hook 自体が Python なのでどの言語のプロジェクトでも Python は必須であり、
テスト基盤（pytest 等）に依存せず単体で走る。

    python scripts/smoke_hooks.py

`main` 上での判定を伴うケースがあるため、`main` を指す一時 git worktree を作って
そこへ現在の hook をコピーして実行する（既に `main` にいる場合はリポジトリ自身を使う）。
終了コードは NG が 1 件でもあれば 1。

> **stdin の BOM に注意**: PowerShell のパイプ（`'{...}' | python hook.py`）は stdin に
> UTF-8 BOM を付けるため、hook が JSON パースに失敗して**フェイルオープンする**
> （＝何も起きず、成功と見分けがつかない）。本スクリプトは bytes を直接渡すため
> 影響を受けない。手で確かめる場合は BOM なしのファイルをリダイレクトすること。
"""

import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
HOOKS = ("block_main_edit.py", "block_main_commit.py", "format_edited_file.py")
DENY = "deny"
PASS = "pass"


def _current_branch(cwd: Path) -> str:
    result = subprocess.run(
        ["git", "symbolic-ref", "--short", "HEAD"],
        capture_output=True,
        text=True,
        cwd=cwd,
    )
    return result.stdout.strip()


def _run(hook_root: Path, hook: str, payload) -> tuple[int, str, str]:
    raw = payload if isinstance(payload, bytes) else json.dumps(payload).encode("utf-8")
    proc = subprocess.run(
        [sys.executable, str(hook_root / ".claude" / "hooks" / hook)],
        input=raw,
        capture_output=True,
        cwd=str(hook_root),
    )
    return (
        proc.returncode,
        proc.stdout.decode("utf-8", "replace"),
        proc.stderr.decode("utf-8", "replace"),
    )


def _check(results: list[bool], hook_root: Path, name: str, hook: str, payload, expect: str) -> None:
    code, out, err = _run(hook_root, hook, payload)
    denied = '"permissionDecision": "deny"' in out
    ok = code == 0 and err.strip() == "" and (denied if expect == DENY else out.strip() == "")
    results.append(ok)
    detail = "deny" if denied else repr(out.strip()[:40])
    print(f"[{'OK ' if ok else 'NG '}] {name} ({hook}) expect={expect} exit={code} "
          f"stdout={detail} stderr={repr(err.strip()[:80])}")


def _cases(hook_root: Path) -> list[bool]:
    """`main` を指す作業ツリー `hook_root` に対してケースを流す。"""
    results: list[bool] = []
    edited = str(hook_root / "README.md")
    notebook = str(hook_root / "notebook.ipynb")
    outside = str(Path(tempfile.gettempdir()) / "outside-the-repo.md")
    cwd = str(hook_root)

    # 編集ブロック（Edit / Write の file_path と NotebookEdit の notebook_path）
    _check(results, hook_root, "S1 main 上の file_path", "block_main_edit.py",
           {"tool_input": {"file_path": edited}}, DENY)
    _check(results, hook_root, "S2 main 上の notebook_path", "block_main_edit.py",
           {"tool_input": {"notebook_path": notebook}}, DENY)
    _check(results, hook_root, "S3 リポジトリ外のパス", "block_main_edit.py",
           {"tool_input": {"file_path": outside}}, PASS)

    # commit / push ブロックと、削除 push の除外
    for name, command, expect in [
        ("S4 main 上の commit", "git commit -m x", DENY),
        ("S5 main 上の push", "git push origin main", DENY),
        ("S6 削除と通常 push の混在", "git push origin main :old", DENY),
        ("S7 --delete による削除", "git push origin --delete old", PASS),
        ("S8 :branch 形の削除", "git push origin :old", PASS),
    ]:
        _check(results, hook_root, name, "block_main_commit.py",
               {"tool_input": {"command": command}, "cwd": cwd}, expect)

    # フェイルオープン（想定外の形の入力）
    for hook in HOOKS:
        for label, payload in [("配列", b"[1, 2]"), ("数値", b"42"), ("文字列", b'"x"'),
                               ("壊れた JSON", b"{")]:
            _check(results, hook_root, f"S9 {label}", hook, payload, PASS)
        _check(results, hook_root, "S10 tool_input が dict でない", hook,
               {"tool_input": "x", "cwd": cwd}, PASS)

    # 整形対象外（format_edited_file は未置換ならそもそも何もしない）
    _check(results, hook_root, "S11 対象ディレクトリ外", "format_edited_file.py",
           {"tool_input": {"file_path": outside}}, PASS)
    return results


def main() -> None:
    if _current_branch(REPO_ROOT) == "main":
        print("カレントブランチが main のため、リポジトリ自身で実行します。\n")
        results = _cases(REPO_ROOT)
    else:
        with tempfile.TemporaryDirectory() as tmp:
            worktree = Path(tmp) / "main-wt"
            add = subprocess.run(
                ["git", "worktree", "add", str(worktree), "main"],
                cwd=REPO_ROOT,
                capture_output=True,
                text=True,
            )
            if add.returncode != 0:
                print(f"main の worktree を作成できませんでした: {add.stderr.strip()}")
                sys.exit(1)
            try:
                for hook in HOOKS:
                    shutil.copy(REPO_ROOT / ".claude" / "hooks" / hook,
                                worktree / ".claude" / "hooks" / hook)
                print(f"main を指す一時 worktree で実行します: {worktree}\n")
                results = _cases(worktree)
            finally:
                subprocess.run(["git", "worktree", "remove", "--force", str(worktree)],
                               cwd=REPO_ROOT, capture_output=True)

    ng = results.count(False)
    print(f"\n{len(results) - ng}/{len(results)} OK, {ng} NG")
    sys.exit(1 if ng else 0)


if __name__ == "__main__":
    main()
