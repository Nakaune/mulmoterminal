#!/bin/sh
# npx が追加した PATH 上の配布物を、コードを実行する前に検証する。
set -eu
candidate="$(command -v mulmoterminal)"
entry="$(readlink -f "$candidate")"
package_dir="$(dirname "$(dirname "$entry")")"
python3 "$HOME/.local/libexec/mulmoterminal-guard/verify.py" runtime "$package_dir"
exec "$candidate" "$@"
