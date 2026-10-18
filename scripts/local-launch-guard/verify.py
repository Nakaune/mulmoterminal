#!/usr/bin/env python3
"""Fail closed against a separately installed, reviewed MulmoTerminal manifest.

This is a regression guard, not protection against deliberate local tampering.
Never learn/approve hashes from the package being checked.
"""
import hashlib
import json
from pathlib import Path
import sys


def digest(file):
    with file.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def verify(mode, target, manifest):
    if manifest.get('schema') != 1 or not manifest.get('archives') or not manifest.get('files'):
        raise ValueError('検証基準が不正です')
    path = Path(target)
    if mode == 'archive':
        if not path.is_absolute() or not path.is_file():
            raise ValueError('検証済みのローカルtgzを絶対パスで指定してください')
        if digest(path) not in manifest['archives']:
            raise ValueError('未検証の配布物です。Codex表示の修正が失われる可能性があるため起動を拒否しました')
    elif mode == 'runtime':
        root = path.resolve(strict=True)
        for rel, expected in manifest['files'].items():
            file = (root / rel).resolve(strict=True)
            if not file.is_relative_to(root) or digest(file) != expected:
                raise ValueError('展開済み配布物が検証済み版と一致しません: ' + rel)
    else:
        raise ValueError('不明な検査モード')


def main():
    try:
        if len(sys.argv) != 3:
            raise ValueError('usage: verify.py archive|runtime PATH')
        manifest = json.loads(Path(__file__).with_name('manifest.json').read_text())
        verify(sys.argv[1], sys.argv[2], manifest)
        print('mulmoterm: 修正版の保護検査に合格 (' + sys.argv[1] + ')')
        return 0
    except (OSError, ValueError, KeyError, TypeError) as error:
        print('mulmoterm: 保護検査に失敗: ' + str(error), file=sys.stderr)
        print('現在の検証済み版を維持します。更新は修正・回帰テストを確認してから検証基準へ登録してください。', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
