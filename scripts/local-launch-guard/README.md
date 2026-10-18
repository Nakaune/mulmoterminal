# MulmoTerminal のローカルリリース保護

`mulmoterm start` / `restart` は、別置きの承認済みmanifestに登録されたSHA-256と配布tgzが
一致しなければ失敗する。`restart` は停止前に選択済みrelease、Node、依存関係、native PTYを
検査するため、未承認版や壊れたruntimeを選んでも稼働中のserverを先に止めない。

現在の起動先は `~/.local/share/mulmoterminal-local/current.json` が選ぶSHA-256識別のreleaseです。
releaseには承認済みtgz、展開済みpackage一式、Node実行ファイル、依存関係、receiptとinventoryを
保存します。起動時にnpm installやpackage取得は行いません。`mulmoterm doctor` は選択中のtgzと
稼働中の配信物を検査します。個数に依存する固定file countは使いません。

インストール先:

- `~/.local/bin/mulmoterm`
- `~/.local/libexec/mulmoterminal-guard/{verify.py,launch.sh,manifest.json,release.py,backup.py,backup.sh}`
- `~/.local/share/mulmoterminal-local/releases/<artifact-sha256>/`
- `~/.local/share/mulmoterminal-local/current.json`

状態確認:

```sh
mulmoterm check-package
mulmoterm release-status
mulmoterm doctor
```

次の指定は未承認のnpm配布物なので失敗し、稼働中のserverを維持します。

```sh
MULMOTERM_PACKAGE=mulmoterminal@latest mulmoterm restart
```

色やキー設定など通常のユーザー設定はruntime hash検査対象外です。保護検査を環境変数で無効にする
機能はありません。

## 更新とバックアップ

現行のnpx runtimeと承認済みtgzから、ネットワーク取得やnpm installをせずにmanaged releaseを
作る手順、選択とrollback、日次ローカルbackup、別ホストへの手動復元は
[OPERATIONS.md](OPERATIONS.md) を参照してください。

新しいtgzはcaptureだけでは承認されません。起動用の別置きmanifestに新しいSHA-256を登録する前に、
tgzと保護対象の変更を人が確認し、関連する回帰確認を行います。`mulmoterm activate ID` は
検証済みreleaseを選択しますが、稼働中serverを再起動しません。切替を反映するには、利用者が
再起動を決めた後に `mulmoterm restart` を実行します。

この検査はランチャーを使った起動経路の退行防止です。ランチャーや `launch.sh` を通さない直接の
実行をOS権限で禁止するものではありません。アプリ内部に自己更新・自己再起動はありません。

確認テスト:

```sh
python3 scripts/local-launch-guard/test_guard.py
python3 scripts/local-launch-guard/test_release.py
python3 scripts/local-launch-guard/test_backup.py
```
