#!/usr/bin/env bash
# Committed source + the selected, verified runtime. No account/session settings.
set -euo pipefail
umask 077
ops="$HOME/.local/libexec/mulmoterminal-guard"
repo="${1:?usage: mulmoterm backup REPO [DESTINATION]}"
destination="${2:-$HOME/.local/share/mulmoterminal-backups}"
scratch="$HOME/.cache/mulmoterminal-ops"
mkdir -p "$scratch" "$destination"
exec 8>"$scratch/backup.lock"
flock -w 600 8
mkdir -p "$HOME/.mulmoterminal"
exec 9>"$HOME/.mulmoterminal/start.lock"
flock -w 600 9
tools="$(mktemp -d "$scratch/tools.XXXXXX")"
trap 'rm -rf -- "$tools"' EXIT
archive="$(python3 "$ops/release.py" selected-archive)"
release="$(python3 "$ops/release.py" resolve --archive "$archive")"
mkdir -p "$tools/guard" "$tools/bin"
for name in verify.py launch.sh manifest.json release.py backup.py backup.sh; do
  cp -p "$ops/$name" "$tools/guard/$name"
done
cp -p "$HOME/.local/bin/mulmoterm" "$tools/bin/mulmoterm"
for name in mt-origin-proxy.mjs mt-heatmap-server.mjs mt-sessions; do
  if [ -f "$HOME/.local/bin/$name" ]; then
    cp -pL "$HOME/.local/bin/$name" "$tools/bin/$name"
  fi
done
cmp "$release/guard/manifest.json" "$tools/guard/manifest.json"
[ "$(python3 "$ops/release.py" selected-release)" = "$release" ]
flock -u 9
exec 9>&-
head="$(git -C "$repo" rev-parse HEAD)"
if ! git -C "$repo" diff --quiet || ! git -C "$repo" diff --cached --quiet; then
  echo 'mulmoterm: commit tracked changes before saving a source backup' >&2
  exit 1
fi
if [ -n "$(git -C "$repo" ls-files --others --exclude-standard)" ]; then
  echo 'mulmoterm: commit or explicitly ignore untracked source files before backup' >&2
  exit 1
fi
fingerprint="$(python3 - "$release/receipt.json" "$head" "$tools" <<'PY'
from pathlib import Path
import hashlib,sys
h=hashlib.sha256(Path(sys.argv[1]).read_bytes()+sys.argv[2].encode())
root=Path(sys.argv[3])
for p in sorted(root.rglob('*')):
    if p.is_file():
        h.update(str(p.relative_to(root)).encode()+str(p.stat().st_mode).encode()+p.read_bytes())
print(h.hexdigest())
PY
)"
last="$destination/last-backup.json"
# Unchanged snapshots are not duplicated by the daily timer. Verify the saved archive.
if python3 - "$last" "$fingerprint" "$destination" <<'PY'
from pathlib import Path
import hashlib,json,sys
try:
    record=json.loads(Path(sys.argv[1]).read_text())
    p=Path(record['snapshot']).resolve(strict=True)
    assert p.is_relative_to(Path(sys.argv[3]).resolve())
    assert record['fingerprint']==sys.argv[2]
    with p.open('rb') as f: assert hashlib.file_digest(f,'sha256').hexdigest()==record['sha256']
except (OSError,ValueError,KeyError,AssertionError,TypeError):
    sys.exit(1)
print('mulmoterm: unchanged backup verified: '+str(p))
PY
then
  exit 0
fi
snapshot="$(python3 "$ops/backup.py" create --repo "$repo" --release "$release" --tools "$tools" --destination "$destination" --scratch-dir "$scratch")"
python3 - "$last" "$fingerprint" "$snapshot" <<'PY'
from pathlib import Path
import datetime,hashlib,json,os,sys
p=Path(sys.argv[3])
with p.open('rb') as f: digest=hashlib.file_digest(f,'sha256').hexdigest()
record={'fingerprint':sys.argv[2],'snapshot':str(p.resolve()),'sha256':digest,'verified_utc':datetime.datetime.now(datetime.timezone.utc).isoformat()}
target=Path(sys.argv[1]);temp=target.with_suffix('.tmp')
temp.write_text(json.dumps(record,indent=2)+'\n');os.replace(temp,target)
print('mulmoterm: verified backup saved: '+str(p))
PY
