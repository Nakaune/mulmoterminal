import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("release_module", HERE / "release.py")
release = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(release)


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name) / "home"
        self.home.mkdir()
        self.guard = self.home / ".local/libexec/mulmoterminal-guard"
        self.guard.mkdir(parents=True)
        self.source = Path(self.tmp.name) / "npm-cache"
        package = self.source / "node_modules/mulmoterminal"
        package.mkdir(parents=True)
        (package / "bin").mkdir()
        (package / "bin/mulmoterminal.js").write_text("verified package\n")
        (self.source / "package.json").write_text('{"name":"cache"}\n')
        (self.source / "package-lock.json").write_text('{"lockfileVersion":3}\n')
        self.archive = Path(self.tmp.name) / "pkg.tgz"
        with release.tarfile.open(self.archive, "w:gz") as tar:
            tar.add(package / "bin/mulmoterminal.js", arcname="bin/mulmoterminal.js")
        self.node = Path(self.tmp.name) / "node"
        self.node.write_text("#!/bin/sh\nexit 0\n")
        self.node.chmod(0o755)
        self.repo = Path(self.tmp.name) / "repo"
        self.repo.mkdir()
        subprocess.run(["git", "init", "-q", str(self.repo)], check=True)
        subprocess.run(["git", "-C", str(self.repo), "config", "user.email", "test@example.com"], check=True)
        subprocess.run(["git", "-C", str(self.repo), "config", "user.name", "Test"], check=True)
        (self.repo / "tracked").write_text("clean\n")
        subprocess.run(["git", "-C", str(self.repo), "add", "tracked"], check=True)
        subprocess.run(["git", "-C", str(self.repo), "commit", "-qm", "initial"], check=True)
        self.write_guard()
        self.store = self.make_store()

    def tearDown(self):
        self.tmp.cleanup()

    def write_guard(self, *, extra=None):
        package_file = self.source / "node_modules/mulmoterminal/bin/mulmoterminal.js"
        manifest = {"schema": 1, "archives": {release.sha(self.archive): "pkg.tgz"},
                    "files": {"bin/mulmoterminal.js": release.sha(package_file)}}
        if extra:
            manifest["description"] = extra
        (self.guard / "manifest.json").write_text(json.dumps(manifest, sort_keys=True, indent=2) + "\n")
        verifier = HERE / "verify.py"
        shutil.copy2(verifier, self.guard / "verify.py")

    def make_store(self, smoke=None):
        return release.ReleaseStore(self.home, smoke_runner=smoke or (lambda runtime, facts: {
            "version": "v22.1.0", "modules_abi": "127", "platform": "linux", "arch": "x64", **facts}))

    def capture(self):
        return self.store.capture(self.source, self.archive, self.repo, self.node)

    def test_capture_is_independent_and_node_is_pinned(self):
        rid = self.capture()
        target = self.store.root / rid
        node_copy = target / "runtime/bin/node"
        self.assertEqual(node_copy.read_bytes(), self.node.read_bytes())
        original = (self.source / "node_modules/mulmoterminal/bin/mulmoterminal.js")
        original.write_text("changed after capture")
        self.node.write_text("changed node")
        self.assertEqual((target / "runtime/node_modules/mulmoterminal/bin/mulmoterminal.js").read_text(), "verified package\n")
        self.assertEqual(node_copy.read_text(), "#!/bin/sh\nexit 0\n")

    def test_capture_rejects_source_mismatch(self):
        (self.source / "node_modules/mulmoterminal/bin/mulmoterminal.js").write_text("tampered\n")
        with self.assertRaises(ValueError):
            self.capture()

    def test_capture_rejects_nonignored_untracked_repo_files(self):
        (self.repo / "untracked.txt").write_text("not committed")
        with self.assertRaises(ValueError):
            self.capture()

    def test_capture_requires_verified_runtime_dependencies(self):
        (self.source / "node_modules/mulmoterminal/bin/mulmoterminal.js").unlink()
        with self.assertRaises((ValueError, FileNotFoundError)):
            self.capture()

    def test_capture_rejects_escaping_or_dangling_symlink(self):
        os.symlink("/etc/passwd", self.source / "node_modules/outside")
        with self.assertRaises(ValueError):
            self.capture()

    def test_select_then_resolve_and_full_inventory_corruption_fails(self):
        rid = self.capture()
        self.store.select(rid)
        self.assertEqual(self.store.selected_release(), str((self.store.root / rid).resolve()))
        self.assertEqual(self.store.resolve(self.archive), str((self.store.root / rid).resolve()))
        (self.store.root / rid / "runtime/node_modules/mulmoterminal/bin/mulmoterminal.js").write_text("bad")
        with self.assertRaises(ValueError):
            self.store.select(rid)

    def test_trusted_manifest_mismatch_refuses_pair(self):
        rid = self.capture()
        self.store.select(rid)
        self.write_guard(extra="changed approval")
        with self.assertRaises(ValueError):
            self.store.selected_archive()

    def test_selected_pair_partial_update_is_refused(self):
        rid = self.capture()
        self.store.select(rid)
        config = json.loads(self.store.config.read_text())
        config["receipt_sha256"] = "0" * 64
        self.store.config.write_text(json.dumps(config))
        with self.assertRaises(ValueError):
            self.store.selected_release()

    def test_archive_must_match_selected_release(self):
        rid = self.capture()
        self.store.select(rid)
        wrong = Path(self.tmp.name) / "wrong.tgz"
        wrong.write_bytes(b"wrong")
        with self.assertRaises(ValueError):
            self.store.resolve(wrong)

    def test_select_records_previous_release(self):
        first = self.capture()
        self.store.select(first)
        # Distinct archive and correspondingly approved second artifact.
        self.archive.write_bytes(b"second archive")
        self.write_guard()
        second = self.capture()
        self.store.select(second)
        self.assertEqual(self.store.previous_id(), first)
        previous_bytes = self.store.previous.read_bytes()
        current_bytes = self.store.config.read_bytes()
        self.store.select(second)
        self.assertEqual(self.store.previous_id(), first)
        self.assertEqual(self.store.previous.read_bytes(), previous_bytes)
        self.assertEqual(self.store.config.read_bytes(), current_bytes)

    def test_failed_select_leaves_current_pair_and_manifest_unchanged(self):
        first = self.capture()
        self.store.select(first)
        old_config = self.store.config.read_bytes()
        old_manifest = (self.guard / "manifest.json").read_bytes()
        self.archive.write_bytes(b"second archive")
        self.write_guard()
        second = self.capture()
        (self.guard / "manifest.json").write_bytes(old_manifest)
        self.store.smoke_runner = lambda runtime, facts: (_ for _ in ()).throw(ValueError("synthetic smoke failure"))
        with self.assertRaisesRegex(ValueError, "synthetic smoke failure"):
            self.store.select(second)
        self.assertEqual(self.store.config.read_bytes(), old_config)
        self.assertEqual((self.guard / "manifest.json").read_bytes(), old_manifest)


if __name__ == "__main__":
    unittest.main()
