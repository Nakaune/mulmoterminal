# Managed release とローカル復旧の手順

この手順はローカルの承認済みtgzをmanaged releaseへ保存し、同じホストで固定版を起動するためのものです。releaseの選択は起動先を記録するだけで、稼働中serverを切り替えません。

## npx runtime からreleaseを保存する

まずソースrepoに、commitする変更や無視設定を決めるファイルが残っていないことを確認します。tracked変更と、ignoreされていないuntracked fileがあるとcaptureは失敗します。ignored fileはGit bundleに含まれません。

```sh
SOURCE_REPO="$HOME/src/mulmoterminal-4.6-local"
git -C "$SOURCE_REPO" status --short --untracked-files=all
```

次に、稼働中のserver processが使っているnpx runtime rootとNode実行ファイルを特定します。`mulmoterm doctor` の `runtime` 行でpackage directoryも照合してください。停止中はこの方法でruntimeを特定できません。

```sh
PID="$(pgrep -f '[m]ulmoterminal/server/index.ts' | head -n 1)"
test -n "$PID"
PACKAGE_DIR="$(readlink -f "/proc/$PID/cwd")"
case "$PACKAGE_DIR" in
  */_npx/*/node_modules/mulmoterminal) CACHE_ROOT="${PACKAGE_DIR%/node_modules/mulmoterminal}" ;;
  *) echo "running package path is unexpected: $PACKAGE_DIR" >&2; exit 1 ;;
esac
NODE_BIN="$(readlink -f "/proc/$PID/exe")"
```

`ARCHIVE`には、実際にそのruntimeを展開したものと同じ、絶対パスのtgzを指定します。例の名前は置き換えてください。installed guard verifierで承認済みであることを先に確認します。

```sh
ARCHIVE="$HOME/.local/share/mulmoterminal-local/<exact-verified-file>.tgz"
python3 "$HOME/.local/libexec/mulmoterminal-guard/verify.py" archive "$ARCHIVE"
```

`capture`はruntime rootの`node_modules`一式を独立コピーします。加えてNode実行ファイル、rootのpackage metadata/lockfile、artifact、検証manifest、receiptを保存し、Firebase/tsxのimportとnative `node-pty`の子PTY起動を確認します。これは依存関係とPTYのsmoke checkで、アプリ全体の起動確認ではありません。

captureは新しいtgzを自動承認しません。archive SHA-256と保護対象fileは別置きinstalled manifestに登録済みでなければ拒否されます。manifestへ新しいhashを登録する前に、tgzと変更内容を確認して回帰テストを行ってください。

```sh
RELEASE_ID="$(python3 "$HOME/.local/libexec/mulmoterminal-guard/release.py" capture \
  --runtime-root "$CACHE_ROOT" --archive "$ARCHIVE" \
  --repo "$SOURCE_REPO" --node "$NODE_BIN")"
printf 'captured release: %s\n' "$RELEASE_ID"
```

releaseは `~/.local/share/mulmoterminal-local/releases/<RELEASE_ID>/` に保存されます。選択と起動前検査は次の通りです。

```sh
mulmoterm activate "$RELEASE_ID"
mulmoterm release-status
mulmoterm prepare
```

`activate`は `current.json` とinstalled manifestをstart lockの下で更新します。再起動はしません。`prepare`は選択中release、checksum、Node ABI、依存import、native PTYを検査しますが、serverを停止・起動しません。運用者が切替を決めた後に `mulmoterm restart` を実行します。restartも停止前に同じruntime検査を完了します。通常のstart/restartは選択済みruntimeを直接起動し、npm installやpackage取得を行いません。

## 戻す

現在の選択を記録してから戻すIDを確認します。

```sh
mulmoterm release-status
python3 "$HOME/.local/libexec/mulmoterminal-guard/release.py" previous-id
```

`previous-id` が返したSHA-256を使います。activateはserverを切り替えないため、内容を検証した後で明示的にrestartします。agent作業中のrestartは、作業を中断する可能性があるため利用者が実行を許可してから行います。

```sh
OLD_SHA="<previous-release-sha256>"
mulmoterm activate "$OLD_SHA"
mulmoterm prepare
# 利用者が再起動を許可した後:
mulmoterm restart
```

## ローカルbackup

```sh
mulmoterm backup "$HOME/src/mulmoterminal-4.6-local"
```

既定保存先は `~/.local/share/mulmoterminal-backups/`、scratchは `~/.cache/mulmoterminal-ops/` です。scratchは展開・再検証用のdisk領域です。`/tmp` がtmpfsの環境では、そこへ1GB超のruntimeを展開しないでください。必要なら2番目の引数に別のローカル保存先を渡せます。

snapshotには次が含まれます。

- 指定repoのGit全refsを含むbundle。現在branchはmetadataに記録され、restore後はそのbranchをcheckoutします。
- 選択中の検証済みmanaged releaseと、allowlistしたguard / launcher scripts。
- archive内inventory、restore案内、外側の `SHA256SUMS`。

tracked変更またはignoreされていないuntracked fileがあればbackupを拒否します。ignored/uncommitted fileはbundleに含めません。選択releaseが前回と同じでsnapshot hashも一致するときは日次timerが重複を省きます。古いbackupを自動削除する処理はありません。

user configの `config.json`、API key、authentication data、`.codex` / `.claude` のhome設定、session log、repo外のuser projectは収集しません。runtime/tools内のsecret名やrelease直下のuser-stateも拒否します。Git bundleは指定repoのcommit済み履歴と全refsを保存するため、そのrepoに個人情報やsecretをcommitしないでください。snapshotはアプリ復旧用で、user dataのbackupではありません。

必要ならローカルuser timerを有効にします。unitはこのrepoのservice fileに合わせたhome下のrepo pathを使います。

```sh
install -d "$HOME/.config/systemd/user"
install -m 0644 scripts/local-launch-guard/mulmoterm-backup.service "$HOME/.config/systemd/user/"
install -m 0644 scripts/local-launch-guard/mulmoterm-backup.timer "$HOME/.config/systemd/user/"
systemctl --user daemon-reload
systemctl --user enable --now mulmoterm-backup.timer
systemctl --user list-timers mulmoterm-backup.timer
```

このtimerはローカルでのみ実行します。変更のないbackupを省きますが、snapshotを外部へ送信しません。`Nakaune/mulmoterminal` はpublic repoなのでsnapshotをそこへuploadしないでください。private backup repoやrelease assetへのoffsite保存先はまだ設定されていません。private targetの選定と利用者の許可が済むまでoffsite backupはありません。

## 別stageへの手動復元

復元先は新規のdirectoryにしてください。verifyとrestoreはscratch directoryを明示します。事前検証、展開後inventory再検証、Git bundleからのcloneだけを行い、アプリやruntimeは実行しません。復元cloneにGit remoteは残りません。

```sh
SNAPSHOT="$HOME/.local/share/mulmoterminal-backups/<snapshot-id>/snapshot.tar.gz"
SCRATCH="$HOME/.cache/mulmoterminal-ops"
STAGE="$HOME/restore-staging/<snapshot-id>"
cd "$(dirname "$SNAPSHOT")"
sha256sum -c SHA256SUMS
python3 "$HOME/.local/libexec/mulmoterminal-guard/backup.py" verify "$SNAPSHOT" --scratch-dir "$SCRATCH"
python3 "$HOME/.local/libexec/mulmoterminal-guard/backup.py" restore "$SNAPSHOT" \
  --destination "$STAGE" --scratch-dir "$SCRATCH"
```

`STAGE`には `source/` (Git source clone)、`source.bundle`、`release/`、`tools/` ができます。`source.bundle`は全refsを保持します。`tools/` と `release/` を稼働homeへコピーする前に、内容・receipt・SHA256SUMSを確認してください。restoreはインストールやserver操作をしません。

復旧先ホストが元と同じOS platform、CPU architecture、libcで、保存されたNodeとnative module ABIに合うことを確認します。receiptのplatform/libcが一致しないhostではactivateできません。異なるhostでは、そのhost上で利用可能なapproved tgzと、同じhost用Node/native dependencyを持つ既存runtimeからcaptureし直してください。install時にnpmで補う手順はありません。

review後、必要なtoolを固定install先へコピーします。既存ファイルを上書きする場合は差分を確認してください。

```sh
install -d "$HOME/.local/bin" "$HOME/.local/libexec/mulmoterminal-guard"
cp -a "$STAGE/tools/bin/." "$HOME/.local/bin/"
cp -a "$STAGE/tools/guard/." "$HOME/.local/libexec/mulmoterminal-guard/"
```

`release/receipt.json` の `artifact_sha256` をrelease IDにし、既存directoryを上書きせず、storeに無いときだけrelease directoryを配置します。

```sh
RELEASE_ID="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["artifact_sha256"])' "$STAGE/release/receipt.json")"
STORE="$HOME/.local/share/mulmoterminal-local/releases"
if [ -e "$STORE/$RELEASE_ID" ]; then
  echo "release already exists; compare it with staged release before proceeding: $STORE/$RELEASE_ID" >&2
  exit 1
fi
install -d "$STORE"
cp -a "$STAGE/release" "$STORE/$RELEASE_ID"
```

その後、SHAを選択して検査します。`activate`は再起動しません。復旧hostで `mulmoterm prepare` が成功することを確認し、アプリ全体のstartup確認が済んだとは扱わないでください。serverを起動する操作は、利用者が許可した後に明示して行います。

```sh
mulmoterm activate "$RELEASE_ID"
mulmoterm release-status
mulmoterm prepare
# 利用者の明示許可後に必要なら:
mulmoterm start
```

## offsite保存

現在、private offsite repositoryやrelease assetの保存先は未設定です。local archive、Git bundle、`SHA256SUMS`を将来private backup repoのrelease assetに保存する方法はありますが、保存先とアクセス範囲を利用者が選び許可するまではuploadしません。public source repoにはsnapshotを置きません。
