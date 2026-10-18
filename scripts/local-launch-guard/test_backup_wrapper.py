"""Exercise the installed backup entry point without touching live services."""
from pathlib import Path
import json
import os
import shutil
import subprocess
import tempfile
import unittest

HERE = Path(__file__).parent


class BackupWrapperTest(unittest.TestCase):
    def test_snapshot_deduplication_and_untracked_source_rejection(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            home = root / 'home'
            ops = home / '.local/libexec/mulmoterminal-guard'
            ops.mkdir(parents=True)
            (home / '.local/bin').mkdir(parents=True)
            (home / '.local/bin/mulmoterm').write_text('#!/bin/sh\nexit 0\n')
            for name in ('backup.sh', 'backup.py'):
                shutil.copy2(HERE / name, ops / name)
            for name in ('verify.py', 'manifest.json', 'launch.sh'):
                (ops / name).write_text('{}\n' if name.endswith('.json') else '# fixture\n')
            release = root / 'release'
            (release / 'guard').mkdir(parents=True)
            (release / 'receipt.json').write_text('{}\n')
            (release / 'artifact.tgz').write_bytes(b'fixture')
            shutil.copy2(ops / 'manifest.json', release / 'guard/manifest.json')
            (ops / 'release.py').write_text('import sys\nprint(' + repr(str(release)) + ' + ("/artifact.tgz" if sys.argv[1] == "selected-archive" else ""))\n')
            repo = root / 'source'
            repo.mkdir()
            env = {**os.environ, 'HOME': str(home), 'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': os.devnull}
            def git(*args):
                subprocess.run(['git', *args], cwd=repo, env=env, check=True, capture_output=True)
            git('init', '-b', 'main')
            git('config', 'user.name', 'Fixture')
            git('config', 'user.email', 'fixture@example.invalid')
            (repo / 'source.txt').write_text('saved\n')
            git('add', '.')
            git('commit', '-m', 'fixture')
            destination = root / 'snapshots'
            command = ['bash', str(ops / 'backup.sh'), str(repo), str(destination)]
            first = subprocess.run(command, env=env, capture_output=True, text=True, timeout=30)
            self.assertEqual(first.returncode, 0, first.stderr)
            record = json.loads((destination / 'last-backup.json').read_text())
            self.assertTrue(Path(record['snapshot']).is_file())
            second = subprocess.run(command, env=env, capture_output=True, text=True, timeout=30)
            self.assertEqual(second.returncode, 0, second.stderr)
            self.assertIn('unchanged backup verified', second.stdout)
            self.assertEqual(len(list(destination.glob('*/snapshot.tar.gz'))), 1)
            (repo / 'new-source.ts').write_text('not committed\n')
            dirty = subprocess.run(command, env=env, capture_output=True, text=True, timeout=30)
            self.assertNotEqual(dirty.returncode, 0)
            self.assertIn('untracked source', dirty.stderr)
            self.assertEqual(len(list(destination.glob('*/snapshot.tar.gz'))), 1)


if __name__ == '__main__':
    unittest.main()
