#!/usr/bin/env python3
"""Create and restore offline, self-contained MulmoTerminal snapshots."""
import argparse
import datetime as dt
import hashlib
import json
import os
import posixpath
from pathlib import Path, PurePosixPath
import platform
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import zlib


SECRET_FILE_NAMES = {
    ".env", ".npmrc", ".netrc", "credentials.json", "id_rsa", "id_ed25519",
}
STATE_ROOT_NAMES = {"config.json", "secrets", "secret", "session-logs", "sessions", "logs"}


def run(*args, cwd=None):
    env = os.environ.copy()
    for key in tuple(env):
        if key.startswith("GIT_CONFIG_") or key in {
            "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY",
            "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_COMMON_DIR",
        }:
            env.pop(key, None)
    env.update({"GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull})
    command = list(args)
    if command and command[0] == "git":
        command[1:1] = ["-c", "core.hooksPath=" + os.devnull, "-c", "init.templateDir=" + os.devnull]
    return subprocess.run(command, cwd=cwd, env=env, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True).stdout.strip()


def sha(path):
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def safe_name(name):
    p = PurePosixPath(name)
    if not name or p.is_absolute() or any(part in ("", ".", "..") for part in p.parts):
        raise ValueError(f"unsafe archive path: {name}")
    return p


def check_tree(root):
    """Inventory a tree while rejecting user-state files and escaping links."""
    root = root.resolve(strict=True)
    result = {}
    for path in sorted(root.rglob("*")):
        rel = path.relative_to(root).as_posix()
        safe_name(rel)
        parts = PurePosixPath(rel).parts
        in_dependency = "node_modules" in parts
        basename = parts[-1].lower()
        is_env_file = basename.startswith(".env") and basename not in {".env.example", ".env.sample"}
        if basename in SECRET_FILE_NAMES or is_env_file:
            raise ValueError(f"refusing protected data in snapshot: {rel}")
        if not in_dependency and len(parts) == 1 and basename in STATE_ROOT_NAMES:
            raise ValueError(f"refusing user state at tree root: {rel}")
        mode = stat.S_IMODE(path.lstat().st_mode)
        if path.is_symlink():
            target = os.readlink(path)
            if os.path.isabs(target) or not (path.parent / target).resolve(strict=False).is_relative_to(root):
                raise ValueError(f"symlink escapes its tree: {rel} -> {target}")
            result[rel] = {"type": "symlink", "mode": mode, "target": target}
        elif path.is_dir():
            result[rel] = {"type": "directory", "mode": mode}
        elif path.is_file():
            result[rel] = {"type": "file", "mode": mode, "sha256": sha(path)}
        else:
            raise ValueError(f"unsupported filesystem entry: {rel}")
    return result


def tracked_clean(repo):
    dirty = run("git", "status", "--porcelain", "--untracked-files=all", cwd=repo)
    if dirty:
        raise ValueError("tracked changes and non-ignored untracked files must be committed or removed before backup")
    branch = run("git", "symbolic-ref", "--quiet", "--short", "HEAD", cwd=repo)
    head = run("git", "rev-parse", "HEAD", cwd=repo)
    return branch, head


def make_inventory(root, extra):
    entries = {}
    for name in ("source.bundle", "README-RESTORE.md"):
        path = root / name
        entries[name] = {"type": "file", "mode": stat.S_IMODE(path.lstat().st_mode), "sha256": sha(path)}
    for tree in ("release", "tools"):
        entries[tree] = {"type": "directory", "mode": stat.S_IMODE((root / tree).lstat().st_mode)}
        entries.update({f"{tree}/{name}": info for name, info in check_tree(root / tree).items()})
    return {"schema": 1, **extra, "entries": entries}


def create(repo, release, tools, destination, scratch_dir=None):
    repo, release, tools = (Path(p).resolve(strict=True) for p in (repo, release, tools))
    destination = Path(destination).resolve()
    if not repo.is_dir() or not release.is_dir() or not tools.is_dir():
        raise ValueError("repo, release, and tools must be directories")
    branch, head = tracked_clean(repo)
    destination.mkdir(parents=True, exist_ok=True)
    stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    final = destination / f"{stamp}-{head[:12]}"
    if final.exists():
        raise FileExistsError(f"snapshot already exists: {final}")
    stage = Path(tempfile.mkdtemp(prefix=".snapshot-", dir=destination))
    try:
        (stage / "release").mkdir()
        (stage / "tools").mkdir()
        shutil.copytree(release, stage / "release", dirs_exist_ok=True, symlinks=True)
        shutil.copytree(tools, stage / "tools", dirs_exist_ok=True, symlinks=True)
        # Check before packaging, and again after copying so source changes cannot slip through.
        check_tree(stage / "release")
        check_tree(stage / "tools")
        run("git", "bundle", "create", str(stage / "source.bundle"), "--all", cwd=repo)
        run("git", "bundle", "verify", str(stage / "source.bundle"), cwd=repo)
        (stage / "README-RESTORE.md").write_text(
            "# Offline snapshot\n\nRestore with `python3 backup.py restore SNAPSHOT --destination NEW_DIR`. "
            "The restored source is under `source/`; release and allowlisted tools are under their own directories. "
            "Restore uses Git to recreate the source tree. No application or runtime is executed, installed, or started.\n",
            encoding="utf-8")
        receipt = release / "receipt.json"
        runtime = json.loads(receipt.read_text(encoding="utf-8")) if receipt.is_file() else None
        inventory = make_inventory(stage, {
            "created_utc": dt.datetime.now(dt.timezone.utc).isoformat(),
            "repo": {"branch": branch, "head": head, "scope": "all refs; current branch checked out"},
            "runtime": {"platform": platform.platform(), "python": platform.python_version(), "receipt": runtime},
        })
        (stage / "inventory.json").write_text(json.dumps(inventory, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        with tarfile.open(stage / "snapshot.tar.gz", "w:gz", format=tarfile.PAX_FORMAT) as archive:
            for item in sorted(stage.iterdir()):
                if item.name != "snapshot.tar.gz":
                    archive.add(item, arcname=item.name, recursive=True)
        verify(stage / "snapshot.tar.gz", scratch_dir)
        for item in (stage / "source.bundle", stage / "release", stage / "tools"):
            if item.is_dir() and not item.is_symlink():
                shutil.rmtree(item)
            elif item.exists() or item.is_symlink():
                item.unlink()
        (stage / "SHA256SUMS").write_text(f"{sha(stage / 'snapshot.tar.gz')}  snapshot.tar.gz\n", encoding="ascii")
        os.rename(stage, final)
        return final / "snapshot.tar.gz"
    except BaseException:
        shutil.rmtree(stage, ignore_errors=True)
        raise


def archive_members(snapshot):
    with tarfile.open(snapshot, "r:gz") as archive:
        members = archive.getmembers()
        names = set()
        for member in members:
            p = safe_name(member.name.rstrip("/"))
            name = p.as_posix()
            if name in names:
                raise ValueError(f"duplicate archive path: {name}")
            names.add(name)
            if member.islnk() or not (member.isfile() or member.isdir() or member.issym()):
                raise ValueError(f"unsupported archive entry: {name}")
            if member.issym():
                resolved = posixpath.normpath(posixpath.join(posixpath.dirname(name), member.linkname))
                if os.path.isabs(member.linkname) or resolved == ".." or resolved.startswith("../"):
                    raise ValueError(f"unsafe archive symlink: {name}")
        return members


def read_inventory(snapshot):
    with tarfile.open(snapshot, "r:gz") as archive:
        member = archive.getmember("inventory.json")
        inventory = json.load(archive.extractfile(member))
    repo = inventory.get("repo")
    if (inventory.get("schema") != 1 or not isinstance(inventory.get("entries"), dict)
            or not isinstance(inventory.get("created_utc"), str)
            or not isinstance(inventory.get("runtime"), dict)
            or not isinstance(repo, dict) or not isinstance(repo.get("branch"), str)
            or not isinstance(repo.get("head"), str) or len(repo["head"]) != 40
            or any(char not in "0123456789abcdef" for char in repo["head"])):
        raise ValueError("invalid inventory")
    return inventory


def verify(snapshot, scratch_dir=None):
    snapshot = Path(snapshot).resolve(strict=True)
    if not snapshot.is_file():
        raise ValueError("snapshot must be a file")
    sums = snapshot.with_name("SHA256SUMS")
    if sums.exists():
        expected_sum = f"{sha(snapshot)}  {snapshot.name}"
        if sums.read_text(encoding="ascii").strip() != expected_sum:
            raise ValueError("snapshot does not match SHA256SUMS")
    members = archive_members(snapshot)
    inventory = read_inventory(snapshot)
    expected = set(inventory["entries"]) | {"inventory.json"}
    if {m.name.rstrip("/") for m in members} != expected:
        raise ValueError("archive contents do not match inventory")
    if scratch_dir is not None:
        Path(scratch_dir).mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="mulmoterm-verify-", dir=scratch_dir) as tmp:
        with tarfile.open(snapshot, "r:gz") as archive:
            extract_safe(archive, members, Path(tmp))
        actual = make_inventory(Path(tmp), {k: inventory[k] for k in ("created_utc", "repo", "runtime")})
        if actual["entries"] != inventory["entries"]:
            raise ValueError("snapshot content hash or metadata mismatch")
        bundle = Path(tmp) / "source.bundle"
        run("git", "bundle", "verify", str(bundle))
        clone = Path(tmp) / "source-check"
        run("git", "clone", "--no-local", "-b", inventory["repo"]["branch"], str(bundle), str(clone))
        if run("git", "rev-parse", "HEAD", cwd=clone) != inventory["repo"]["head"]:
            raise ValueError("bundle head does not match inventory")
    return inventory


def extract_safe(archive, members, root):
    root.mkdir(parents=True, exist_ok=True)
    for member in members:
        if member.isdir():
            path = root / safe_name(member.name.rstrip("/"))
            path.mkdir(parents=True, exist_ok=True)
    for member in members:
        if member.isfile():
            path = root / safe_name(member.name)
            path.parent.mkdir(parents=True, exist_ok=True)
            # All symlinks are created last, so file writes cannot traverse them.
            with archive.extractfile(member) as src, path.open("xb") as dst:
                shutil.copyfileobj(src, dst)
            path.chmod(member.mode & 0o777)
    for member in members:
        if member.issym():
            path = root / safe_name(member.name)
            path.parent.mkdir(parents=True, exist_ok=True)
            os.symlink(member.linkname, path)
    for member in sorted((m for m in members if m.isdir()), key=lambda m: m.name.count("/"), reverse=True):
        (root / safe_name(member.name.rstrip("/"))).chmod(member.mode & 0o777)


def restore(snapshot, destination, scratch_dir=None):
    destination = Path(destination).absolute()
    if destination.exists():
        raise FileExistsError("restore destination must not exist")
    inventory = verify(snapshot, scratch_dir)
    destination.parent.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix=f".{destination.name}-restore-", dir=destination.parent))
    try:
        members = archive_members(Path(snapshot))
        with tarfile.open(snapshot, "r:gz") as archive:
            extract_safe(archive, members, stage)
        actual = make_inventory(stage, {k: inventory[k] for k in ("created_utc", "repo", "runtime")})
        if actual["entries"] != inventory["entries"]:
            raise ValueError("restored files failed verification")
        run("git", "clone", "--no-local", "-b", inventory["repo"]["branch"], str(stage / "source.bundle"), str(stage / "source"))
        run("git", "remote", "remove", "origin", cwd=stage / "source")
        if run("git", "rev-parse", "HEAD", cwd=stage / "source") != inventory["repo"]["head"]:
            raise ValueError("restored repository head does not match inventory")
        os.rename(stage, destination)
    except BaseException:
        shutil.rmtree(stage, ignore_errors=True)
        raise
    return destination


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("create")
    p.add_argument("--repo", required=True); p.add_argument("--release", required=True)
    p.add_argument("--tools", required=True); p.add_argument("--destination", required=True)
    p.add_argument("--scratch-dir")
    p = sub.add_parser("verify"); p.add_argument("snapshot"); p.add_argument("--scratch-dir")
    p = sub.add_parser("restore"); p.add_argument("snapshot"); p.add_argument("--destination", required=True); p.add_argument("--scratch-dir")
    args = parser.parse_args()
    try:
        if args.command == "create":
            print(create(args.repo, args.release, args.tools, args.destination, args.scratch_dir))
        elif args.command == "verify":
            verify(args.snapshot, args.scratch_dir); print("snapshot verified")
        else:
            print(restore(args.snapshot, args.destination, args.scratch_dir))
        return 0
    except (OSError, ValueError, KeyError, TypeError, subprocess.CalledProcessError, tarfile.TarError, zlib.error) as error:
        print(f"backup: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
