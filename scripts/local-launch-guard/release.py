#!/usr/bin/env python3
"""Manage locally captured, offline MulmoTerminal runtimes.

The separately installed guard manifest is the only source of package approval.
This module never installs packages or starts the application.
"""
import argparse
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import platform
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import time

GUARD = Path.home() / ".local/libexec/mulmoterminal-guard"
STORE = Path.home() / ".local/share/mulmoterminal-local/releases"
CONFIG = STORE.parent / "current.json"
PREVIOUS = STORE.parent / "current.previous.json"
LOCK = Path.home() / ".mulmoterminal/start.lock"
FORBIDDEN = {".env", ".npmrc", ".netrc", "credentials.json"}


def sha(path):
    h = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def json_bytes(value):
    return (json.dumps(value, sort_keys=True, indent=2) + "\n").encode()


def atomic_write(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix="." + path.name + ".", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
        dfd = os.open(path.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        try:
            os.fsync(dfd)
        finally:
            os.close(dfd)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def tree_inventory(root):
    root = Path(root).resolve(strict=True)
    items = {}
    for path in sorted(root.rglob("*")):
        rel = path.relative_to(root).as_posix()
        parts = PurePosixPath(rel).parts
        if not rel or any(p in ("", ".", "..") for p in parts):
            raise ValueError("unsafe runtime path: " + rel)
        basename = parts[-1].lower()
        if basename in FORBIDDEN or (basename.startswith(".env") and basename not in {".env.example", ".env.sample"}):
            raise ValueError("protected file in runtime: " + rel)
        mode = stat.S_IMODE(path.lstat().st_mode)
        if path.is_symlink():
            target = os.readlink(path)
            if os.path.isabs(target):
                raise ValueError("absolute symlink: " + rel)
            try:
                resolved = (path.parent / target).resolve(strict=True)
            except (OSError, RuntimeError) as error:
                raise ValueError("dangling or cyclic symlink: " + rel) from error
            if not resolved.is_relative_to(root):
                raise ValueError("symlink escapes runtime: " + rel)
            items[rel] = {"type": "symlink", "mode": mode, "target": target}
        elif path.is_dir():
            items[rel] = {"type": "directory", "mode": mode}
        elif path.is_file():
            items[rel] = {"type": "file", "mode": mode, "sha256": sha(path)}
        else:
            raise ValueError("unsupported runtime entry: " + rel)
    return items


def host_facts():
    libc, libc_version = platform.libc_ver()
    if not libc:
        libc = "unknown"
    return {"platform": sys.platform, "machine": platform.machine(), "libc": libc, "libc_version": libc_version}


def run(command, *, cwd=None, timeout=20, env=None):
    clean_env = os.environ.copy()
    for key in tuple(clean_env):
        if key.lower() in {"node_options", "npm_config_userconfig", "npm_config_globalconfig"} or key.startswith("GIT_CONFIG_") or key in {
            "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY",
            "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_COMMON_DIR",
        }:
            clean_env.pop(key, None)
    clean_env.update({"GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull})
    if env:
        clean_env.update(env)
    result = subprocess.run(command, cwd=cwd, env=clean_env, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, text=True, timeout=timeout, check=False)
    if result.returncode:
        raise ValueError("command failed: " + " ".join(map(str, command)) + ": " + result.stderr[-1200:])
    return result.stdout.strip()


class ReleaseStore:
    def __init__(self, home=None, *, smoke_runner=None):
        self.home = Path(home or Path.home()).resolve()
        self.root = self.home / ".local/share/mulmoterminal-local/releases"
        self.config = self.root.parent / "current.json"
        self.previous = self.root.parent / "current.previous.json"
        self.guard = self.home / ".local/libexec/mulmoterminal-guard"
        self.lock = self.home / ".mulmoterminal/start.lock"
        self.smoke_runner = smoke_runner or self._smoke

    def _locked(self):
        self.lock.parent.mkdir(parents=True, exist_ok=True)
        stream = self.lock.open("a+")
        fcntl.flock(stream, fcntl.LOCK_EX)
        return stream

    def _manifest(self):
        path = self.guard / "manifest.json"
        data = path.read_bytes()
        manifest = json.loads(data)
        if manifest.get("schema") != 1 or not manifest.get("archives") or not manifest.get("files"):
            raise ValueError("trusted installed manifest is invalid")
        return manifest, hashlib.sha256(data).hexdigest()

    def _verifier(self):
        path = self.guard / "verify.py"
        if not path.is_file() or path.is_symlink():
            raise ValueError("installed trusted verifier is missing or unsafe")
        spec = importlib.util.spec_from_file_location("mulmoterminal_installed_verify", path)
        module = importlib.util.module_from_spec(spec)
        old = sys.dont_write_bytecode
        sys.dont_write_bytecode = True
        try:
            spec.loader.exec_module(module)
        finally:
            sys.dont_write_bytecode = old
        return module

    def _verify_approved(self, artifact, runtime_package):
        verifier = self._verifier()
        manifest, digest = self._manifest()
        verifier.verify("archive", str(Path(artifact).resolve(strict=True)), manifest)
        verifier.verify("runtime", str(Path(runtime_package).resolve(strict=True)), manifest)
        return manifest, digest

    def _smoke(self, runtime, facts):
        node = runtime / "bin/node"
        node_info = json.loads(run([str(node), "-p", "JSON.stringify({version:process.version,modules:process.versions.modules,platform:process.platform,arch:process.arch})"], timeout=20))
        source = """await Promise.all([import('firebase/firestore'),import('tsx')]); const mod=await import('node-pty'); const {spawn}=mod.spawn?mod:mod.default; if(typeof spawn!=='function')throw new Error('node-pty spawn is unavailable'); await new Promise((resolve,reject)=>{const p=spawn('/bin/sh',['-c','exit 0'],{name:'xterm',cols:80,rows:24,cwd:process.cwd(),env:process.env});const t=setTimeout(()=>{p.kill();reject(new Error('PTY timeout'))},10000);p.onExit(({exitCode,signal})=>{clearTimeout(t);if(exitCode===0&&!signal)resolve();else reject(new Error('PTY child failed'))})})"""
        expected_arch = {"x86_64": "x64", "aarch64": "arm64"}.get(platform.machine(), platform.machine())
        if node_info["platform"] != sys.platform or node_info["arch"] != expected_arch:
            raise ValueError("copied Node binary does not match the host platform/architecture")
        run([str(node), "--input-type=module", "-e", source], cwd=runtime / "node_modules/mulmoterminal", timeout=20,
            env={"NO_PROXY": "*", "no_proxy": "*", "npm_config_offline": "true"})
        return {"version": node_info["version"], "modules_abi": node_info["modules"],
                "platform": node_info["platform"], "arch": node_info["arch"], **facts}

    def capture(self, runtime_root, archive, repo, node):
        lock = self._locked()
        try:
            artifact = Path(archive)
            if not artifact.is_absolute() or not artifact.is_file():
                raise ValueError("archive must be an existing absolute path")
            repo = Path(repo).resolve(strict=True)
            runtime_root = Path(runtime_root).resolve(strict=True)
            package = runtime_root / "node_modules/mulmoterminal"
            binary = Path(node)
            if not binary.is_absolute() or binary.is_symlink() or not binary.is_file() or not os.access(binary, os.X_OK):
                raise ValueError("--node must name the resolved executable Node binary")
            binary = binary.resolve(strict=True)
            manifest, manifest_digest = self._verify_approved(artifact, package)
            branch = run(["git", "symbolic-ref", "--quiet", "--short", "HEAD"], cwd=repo)
            commit = run(["git", "rev-parse", "HEAD"], cwd=repo)
            if run(["git", "status", "--porcelain", "--untracked-files=all"], cwd=repo):
                raise ValueError("repository must have no tracked changes or non-ignored untracked files")
            source_inventory = tree_inventory(package)
            cache_inventory = tree_inventory(runtime_root / "node_modules")
            node_digest = sha(binary)
            artifact_digest = sha(artifact)
            package_files = {}
            for name in ("package.json", "package-lock.json"):
                source = runtime_root / name
                if not source.is_file():
                    raise ValueError("runtime root is missing " + name)
                package_files[name] = sha(source)
            facts = host_facts()
            self.root.mkdir(parents=True, exist_ok=True)
            final = self.root / artifact_digest
            if final.exists() or final.is_symlink():
                self._validate_release(final, expected_manifest=manifest_digest, smoke=True)
                return artifact_digest
            stage = Path(tempfile.mkdtemp(prefix=".capture-", dir=self.root))
            try:
                (stage / "guard").mkdir()
                (stage / "runtime/bin").mkdir(parents=True)
                shutil.copy2(artifact, stage / "artifact.tgz")
                shutil.copy2(self.guard / "verify.py", stage / "guard/verify.py")
                shutil.copy2(self.guard / "manifest.json", stage / "guard/manifest.json")
                shutil.copy2(binary, stage / "runtime/bin/node")
                os.chmod(stage / "runtime/bin/node", stat.S_IMODE(binary.stat().st_mode) | 0o111)
                shutil.copytree(runtime_root / "node_modules", stage / "runtime/node_modules", symlinks=True)
                for name in ("package.json", "package-lock.json"):
                    source = runtime_root / name
                    if source.is_file():
                        shutil.copy2(source, stage / "runtime" / name)
                if sha(stage / "artifact.tgz") != artifact_digest or sha(stage / "runtime/bin/node") != node_digest:
                    raise ValueError("protected source changed during capture")
                if any(sha(stage / "runtime" / name) != digest for name, digest in package_files.items()):
                    raise ValueError("runtime package metadata changed during capture")
                if tree_inventory(package) != source_inventory or tree_inventory(runtime_root / "node_modules") != cache_inventory:
                    raise ValueError("runtime source changed during capture")
                target_package = stage / "runtime/node_modules/mulmoterminal"
                if tree_inventory(target_package) != source_inventory or tree_inventory(stage / "runtime/node_modules") != cache_inventory:
                    raise ValueError("copied runtime differs from verified source")
                self._verify_approved(stage / "artifact.tgz", target_package)
                smoke = self.smoke_runner(stage / "runtime", facts)
                entries = tree_inventory(stage)
                receipt = {"schema": 1, "artifact_sha256": artifact_digest,
                           "manifest_sha256": manifest_digest,
                           "inventory_sha256": hashlib.sha256(json_bytes(entries)).hexdigest(),
                           "node": smoke, "host": facts,
                           "source": {"repo": str(repo), "branch": branch, "commit": commit},
                           "captured_unix": int(time.time())}
                (stage / "inventory.json").write_bytes(json_bytes(entries))
                (stage / "receipt.json").write_bytes(json_bytes(receipt))
                # Inventory excludes its own files; bind both metadata files in receipt.
                receipt["inventory_file_sha256"] = sha(stage / "inventory.json")
                atomic_write(stage / "receipt.json", json_bytes(receipt))
                os.rename(stage, final)
            except BaseException:
                shutil.rmtree(stage, ignore_errors=True)
                raise
            return artifact_digest
        finally:
            lock.close()

    def _read_receipt(self, release):
        if release.is_symlink() or not release.is_dir():
            raise ValueError("release directory is missing or symlinked")
        data = (release / "receipt.json").read_bytes()
        receipt = json.loads(data)
        if receipt.get("schema") != 1 or release.name != receipt.get("artifact_sha256"):
            raise ValueError("release receipt identity mismatch")
        return receipt, hashlib.sha256(data).hexdigest()

    def _validate_release(self, release, *, expected_manifest=None, smoke=False, saved_guard=False):
        receipt, _ = self._read_receipt(release)
        if expected_manifest and receipt.get("manifest_sha256") != expected_manifest:
            raise ValueError("release was approved by a different trusted manifest")
        entries = json.loads((release / "inventory.json").read_text())
        if receipt.get("inventory_file_sha256") != sha(release / "inventory.json"):
            raise ValueError("release inventory checksum mismatch")
        # Compare content and metadata. Receipt/inventory are bound separately to avoid recursion.
        actual = tree_inventory(release)
        actual.pop("inventory.json", None)
        actual.pop("receipt.json", None)
        if actual != entries:
            raise ValueError("release full inventory mismatch")
        if receipt.get("inventory_sha256") != hashlib.sha256(json_bytes(entries)).hexdigest():
            raise ValueError("release inventory digest mismatch")
        if saved_guard:
            guard_dir = release / "guard"
            manifest_data = (guard_dir / "manifest.json").read_bytes()
            manifest = json.loads(manifest_data)
            digest = hashlib.sha256(manifest_data).hexdigest()
            if (guard_dir / "verify.py").is_symlink() or not (guard_dir / "verify.py").is_file():
                raise ValueError("captured verifier is missing or unsafe")
            # Use the installed verifier's code with the captured manifest. Never
            # execute code supplied by a candidate release during selection.
            verifier = self._verifier()
        else:
            manifest, digest = self._manifest()
            verifier = self._verifier()
        if digest != receipt.get("manifest_sha256"):
            raise ValueError("release guard manifest does not match its receipt")
        if sha(release / "artifact.tgz") != receipt.get("artifact_sha256"):
            raise ValueError("release archive checksum mismatch")
        verifier.verify("archive", str(release / "artifact.tgz"), manifest)
        verifier.verify("runtime", str(release / "runtime/node_modules/mulmoterminal"), manifest)
        if receipt.get("host") != host_facts():
            raise ValueError("release platform/libc does not match this host")
        if smoke:
            self.smoke_runner(release / "runtime", host_facts())
        return receipt

    def _pair(self):
        data = self.config.read_bytes()
        config = json.loads(data)
        if config.get("schema") != 1:
            raise ValueError("current release config is invalid")
        release_id = config.get("release_id")
        if not isinstance(release_id, str) or len(release_id) != 64 or any(c not in "0123456789abcdef" for c in release_id):
            raise ValueError("current release id is invalid")
        if self.root.is_symlink():
            raise ValueError("release store root is symlinked")
        release = self.root / release_id
        receipt, receipt_digest = self._read_receipt(release)
        manifest, manifest_digest = self._manifest()
        if release_id != receipt.get("artifact_sha256") or config.get("receipt_sha256") != receipt_digest:
            raise ValueError("current release pair does not match its receipt")
        if config.get("manifest_sha256") != manifest_digest or receipt.get("manifest_sha256") != manifest_digest:
            raise ValueError("current release pair does not match installed approval")
        return config, release, receipt

    def select(self, release_id):
        lock = self._locked()
        try:
            if len(release_id) != 64 or any(c not in "0123456789abcdef" for c in release_id):
                raise ValueError("release id must be a SHA-256")
            release = self.root / release_id
            receipt = self._validate_release(release, smoke=True, saved_guard=True)
            manifest_data = (release / "guard/manifest.json").read_bytes()
            manifest = json.loads(manifest_data)
            manifest_digest = hashlib.sha256(manifest_data).hexdigest()
            if receipt["artifact_sha256"] != release_id:
                raise ValueError("release id does not match artifact")
            try:
                old = json.loads(self.config.read_text())
            except FileNotFoundError:
                old = None
            same_release = bool(old and old.get("release_id") == release_id)
            if old and not same_release:
                atomic_write(self.previous, json_bytes(old))
            # Explicit local selection approves the captured guard manifest.
            saved = (release / "guard/manifest.json").read_bytes()
            if hashlib.sha256(saved).hexdigest() != manifest_digest or json.loads(saved) != manifest:
                raise ValueError("captured guard manifest differs from current approval")
            atomic_write(self.guard / "manifest.json", saved)
            config = {"schema": 1, "release_id": release_id,
                      "receipt_sha256": sha(release / "receipt.json"),
                      "manifest_sha256": manifest_digest}
            previous_id = None
            if same_release:
                previous_id = old.get("previous_release_id")
            elif old and old.get("release_id"):
                previous_id = old["release_id"]
            if previous_id:
                config["previous_release_id"] = previous_id
            atomic_write(self.config, json_bytes(config))
            return release_id
        finally:
            lock.close()

    def resolve(self, archive):
        config, release, receipt = self._pair()
        path = Path(archive)
        if not path.is_absolute() or sha(path) != config["release_id"]:
            raise ValueError("archive does not match selected release")
        self._validate_release(release, expected_manifest=config["manifest_sha256"], smoke=True)
        return str(release.resolve(strict=True))

    def selected_archive(self):
        _, release, _ = self._pair()
        return str((release / "artifact.tgz").resolve(strict=True))

    def selected_release(self):
        _, release, _ = self._pair()
        return str(release.resolve(strict=True))

    def previous_id(self):
        config = json.loads(self.config.read_text())
        previous = config.get("previous_release_id")
        if not previous:
            raise ValueError("no previous release is recorded")
        return previous

    def status(self):
        try:
            config, release, receipt = self._pair()
            return {"selected": config["release_id"], "release": str(release),
                    "source": receipt.get("source"), "node": receipt.get("node"), "valid_pair": True}
        except (OSError, ValueError, KeyError, TypeError) as error:
            return {"selected": None, "valid_pair": False, "error": str(error)}


def main(argv=None):
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    cap = sub.add_parser("capture")
    cap.add_argument("--runtime-root", required=True)
    cap.add_argument("--archive", required=True)
    cap.add_argument("--repo", required=True)
    cap.add_argument("--node", required=True)
    sel = sub.add_parser("select"); sel.add_argument("release_id")
    res = sub.add_parser("resolve"); res.add_argument("--archive", required=True)
    for name in ("selected-archive", "selected-release", "previous-id", "status"):
        sub.add_parser(name)
    args = parser.parse_args(argv)
    store = ReleaseStore()
    try:
        if args.command == "capture":
            result = store.capture(args.runtime_root, args.archive, args.repo, args.node)
        elif args.command == "select": result = store.select(args.release_id)
        elif args.command == "resolve": result = store.resolve(args.archive)
        elif args.command == "selected-archive": result = store.selected_archive()
        elif args.command == "selected-release": result = store.selected_release()
        elif args.command == "previous-id": result = store.previous_id()
        else: result = store.status()
        print(json.dumps(result, sort_keys=True) if args.command == "status" else result)
        return 0
    except (OSError, ValueError, KeyError, TypeError, subprocess.TimeoutExpired, tarfile.TarError) as error:
        print("release: " + str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
