#!/usr/bin/env python3
"""Offline integration tests for backup.py."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest


SCRIPT = Path(__file__).with_name("backup.py")
spec = importlib.util.spec_from_file_location("backup", SCRIPT)
backup = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = backup
spec.loader.exec_module(backup)


def git(repo, *args):
    return subprocess.run(["git", *args], cwd=repo, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True).stdout.strip()


class BackupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.repo = self.root / "repo"
        self.repo.mkdir()
        git(self.repo, "init", "-b", "main")
        git(self.repo, "config", "user.name", "Fixture")
        git(self.repo, "config", "user.email", "fixture@example.invalid")
        (self.repo / "tracked.txt").write_text("committed source\n")
        git(self.repo, "add", "tracked.txt")
        git(self.repo, "commit", "-m", "fixture")
        self.head = git(self.repo, "rev-parse", "HEAD")
        git(self.repo, "checkout", "-b", "extra")
        (self.repo / "extra.txt").write_text("other branch\n")
        git(self.repo, "add", "extra.txt")
        git(self.repo, "commit", "-m", "extra branch")
        self.extra_head = git(self.repo, "rev-parse", "HEAD")
        git(self.repo, "checkout", "main")
        self.release = self.root / "release"
        (self.release / "node_modules" / "fixture").mkdir(parents=True)
        runtime = self.release / "node_modules" / "fixture" / "run.sh"
        runtime.write_text("#!/bin/sh\nexit 0\n")
        runtime.chmod(0o755)
        (self.release / "node_modules" / "fixture" / "config.json").write_text('{"dependency": true}\n')
        (self.release / "node_modules" / "fixture" / "logs").mkdir()
        (self.release / ".env.example").write_text("EXAMPLE=value\n")
        (self.release / "run-link").symlink_to("node_modules/fixture/run.sh")
        (self.release / "receipt.json").write_text(json.dumps({"node": "v24.1.0", "release": "fixture"}))
        self.tools = self.root / "tools"
        self.tools.mkdir()
        tool = self.tools / "approved-tool.py"
        tool.write_text("print('safe')\n")
        tool.chmod(0o755)
        self.backups = self.root / "backups"

    def tearDown(self):
        self.temp.cleanup()

    def make_snapshot(self):
        return backup.create(self.repo, self.release, self.tools, self.backups)

    def test_offline_round_trip_preserves_source_modes_symlinks_and_runtime(self):
        snapshot = self.make_snapshot()
        info = backup.verify(snapshot)
        restored = backup.restore(snapshot, self.root / "restored")
        self.assertEqual(info["repo"]["head"], self.head)
        self.assertEqual(git(restored / "source", "rev-parse", "HEAD"), self.head)
        self.assertEqual((restored / "source" / "tracked.txt").read_text(), "committed source\n")
        self.assertTrue((restored / "release/node_modules/fixture/run.sh").stat().st_mode & 0o111)
        self.assertTrue((restored / "release/run-link").is_symlink())
        self.assertEqual(os.readlink(restored / "release/run-link"), "node_modules/fixture/run.sh")
        self.assertEqual((restored / "release/node_modules/fixture/config.json").read_text(), '{"dependency": true}\n')
        self.assertEqual((restored / "release/.env.example").read_text(), "EXAMPLE=value\n")
        self.assertEqual((restored / "tools/approved-tool.py").read_text(), "print('safe')\n")
        self.assertEqual(git(restored / "source", "remote"), "")
        heads = git(restored / "source", "bundle", "list-heads", str(restored / "source.bundle"))
        self.assertIn(f"{self.extra_head} refs/heads/extra", heads.splitlines())
        self.assertEqual({item.name for item in snapshot.parent.iterdir()}, {"snapshot.tar.gz", "SHA256SUMS", "inventory.json", "README-RESTORE.md"})

    def test_scratch_directory_is_used_and_cleaned(self):
        snapshot = self.make_snapshot()
        scratch = self.root / "scratch"
        backup.verify(snapshot, scratch)
        self.assertEqual(list(scratch.iterdir()), [])

    def test_corrupt_archive_fails_before_destination_creation(self):
        snapshot = self.make_snapshot()
        data = bytearray(snapshot.read_bytes())
        data[len(data) // 2] ^= 0x01
        broken = self.root / "broken.tar.gz"
        broken.write_bytes(data)
        destination = self.root / "must-not-exist"
        with self.assertRaises(Exception):
            backup.restore(broken, destination)
        self.assertFalse(destination.exists())

    def test_tar_path_traversal_is_rejected(self):
        malicious = self.root / "malicious.tar.gz"
        with tarfile.open(malicious, "w:gz") as archive:
            info = tarfile.TarInfo("../outside")
            info.size = 1
            import io
            archive.addfile(info, io.BytesIO(b"x"))
        with self.assertRaises(ValueError):
            backup.verify(malicious)

    def test_existing_destination_is_refused(self):
        snapshot = self.make_snapshot()
        destination = self.root / "existing"
        destination.mkdir()
        marker = destination / "keep"
        marker.write_text("untouched")
        with self.assertRaises(FileExistsError):
            backup.restore(snapshot, destination)
        self.assertEqual(marker.read_text(), "untouched")

    def test_tracked_dirty_repository_is_rejected_but_untracked_cache_is_ignored(self):
        (self.repo / ".git" / "info" / "exclude").write_text("__pycache__/\n")
        (self.repo / "__pycache__").mkdir()
        (self.repo / "__pycache__" / "ignored.pyc").write_bytes(b"cache")
        # Ignored caches are outside the bundle and do not make the committed tree dirty.
        self.make_snapshot()
        (self.repo / "tracked.txt").write_text("modified\n")
        with self.assertRaisesRegex(ValueError, "tracked changes"):
            self.make_snapshot()

    def test_nonignored_untracked_source_is_rejected(self):
        (self.repo / "new-source.txt").write_text("not in Git history\n")
        with self.assertRaisesRegex(ValueError, "non-ignored untracked files"):
            self.make_snapshot()

    def test_escaping_symlink_is_rejected(self):
        outside = self.release / "escape"
        outside.symlink_to("../../outside")
        with self.assertRaisesRegex(ValueError, "symlink escapes"):
            self.make_snapshot()

    def test_symlink_chain_escaping_tree_is_rejected(self):
        (self.release / "first").symlink_to("second")
        (self.release / "second").symlink_to("../../outside")
        with self.assertRaisesRegex(ValueError, "symlink escapes"):
            self.make_snapshot()

    def test_user_state_secret_filename_is_rejected(self):
        (self.release / ".env.local").write_text("TOKEN=private\n")
        with self.assertRaisesRegex(ValueError, "protected data"):
            self.make_snapshot()

    def test_malformed_inventory_is_rejected(self):
        malformed = self.root / "malformed.tar.gz"
        import io
        with tarfile.open(malformed, "w:gz") as archive:
            info = tarfile.TarInfo("inventory.json")
            payload = b'{"schema": 9, "entries": {}}'
            info.size = len(payload)
            archive.addfile(info, io.BytesIO(payload))
        with self.assertRaisesRegex(ValueError, "invalid inventory"):
            backup.verify(malformed)


if __name__ == "__main__":
    unittest.main()
