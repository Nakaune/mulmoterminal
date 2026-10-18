import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest

HERE = Path(__file__).parent
spec = importlib.util.spec_from_file_location('guard', HERE / 'verify.py')
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


class GuardTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.archive = self.root / 'valid.tgz'
        self.archive.write_bytes(b'verified archive')
        self.file = self.root / 'server' / 'fix.ts'
        self.file.parent.mkdir()
        self.file.write_bytes(b'verified code')
        self.manifest = {'schema': 1, 'archives': {guard.digest(self.archive): 'valid'},
                         'files': {'server/fix.ts': guard.digest(self.file)}}

    def test_verified_package_and_runtime(self):
        guard.verify('archive', str(self.archive), self.manifest)
        guard.verify('runtime', str(self.root), self.manifest)

    def test_old_or_modified_archive(self):
        self.archive.write_bytes(b'old version')
        with self.assertRaises(ValueError):
            guard.verify('archive', str(self.archive), self.manifest)

    def test_registry_spec_and_missing_file(self):
        for target in ['mulmoterminal@latest', 'https://example.invalid/a.tgz', str(self.root / 'absent.tgz')]:
            with self.assertRaises(ValueError):
                guard.verify('archive', target, self.manifest)

    def test_missing_and_modified_runtime(self):
        self.file.write_bytes(b'old code')
        with self.assertRaises(ValueError):
            guard.verify('runtime', str(self.root), self.manifest)
        self.file.unlink()
        with self.assertRaises(OSError):
            guard.verify('runtime', str(self.root), self.manifest)

    def test_runtime_symlink_outside_package(self):
        target = self.root / 'outside.ts'
        target.write_bytes(b'verified code')
        self.file.unlink()
        self.file.symlink_to(target)
        package = self.root / 'package'
        package.mkdir()
        (package / 'server').symlink_to(self.file.parent)
        with self.assertRaises(ValueError):
            guard.verify('runtime', str(package), self.manifest)

    def test_missing_manifest_fails_closed(self):
        script = self.root / 'verify.py'
        script.write_text((HERE / 'verify.py').read_text())
        result = subprocess.run(['python3', str(script), 'archive', str(self.archive)], capture_output=True)
        self.assertEqual(result.returncode, 1)

    def test_restart_rejects_before_stop(self):
        launcher = (HERE / 'mulmoterm').read_text()
        definitions, dispatch = launcher.split('case "${1:-start}" in', 1)
        # Stub only service mutations; exercise the real dispatch and package verifier.
        definitions = definitions.replace('$HOME/.local/libexec/mulmoterminal-guard/verify.py', str(HERE / 'verify.py'))
        definitions = definitions.replace('$HOME/.mulmoterminal/start.lock', str(self.root / 'start.lock'))
        script = self.root / 'launcher'
        marker = self.root / 'stopped'
        script.write_text(definitions + '\nstop() { touch "' + str(marker) + '"; }\nstart() { return 0; }\ncase "${1:-start}" in' + dispatch)
        import os
        result = subprocess.run(['bash', str(script), 'restart'], env={**os.environ, 'MULMOTERM_PACKAGE': 'mulmoterminal@latest'}, capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(marker.exists())
        self.assertIn('保護検査に失敗'.encode(), result.stderr)

    def test_lifecycle_lock_serializes_commands(self):
        definitions = (HERE / 'mulmoterm').read_text().split('case "${1:-start}" in', 1)[0]
        definitions = definitions.replace('$HOME/.mulmoterminal/start.lock', str(self.root / 'start.lock'))
        script = self.root / 'locking.sh'
        events = self.root / 'events'
        script.write_text(definitions + '\nprobe() { echo begin >> "' + str(events) + '"; sleep 0.2; echo end >> "' + str(events) + '"; }\nwith_start_lock probe\n')
        processes = [subprocess.Popen(['bash', str(script)], stdout=subprocess.PIPE, stderr=subprocess.PIPE) for _ in range(2)]
        for process in processes:
            _, errors = process.communicate(timeout=10)
            self.assertEqual(process.returncode, 0, errors)
        self.assertEqual(events.read_text().splitlines(), ['begin', 'end', 'begin', 'end'])

    def test_restart_preflight_failure_never_stops_running_service(self):
        definitions, dispatch = (HERE / 'mulmoterm').read_text().split('case "${1:-start}" in', 1)
        definitions = definitions.replace('$HOME/.mulmoterminal/start.lock', str(self.root / 'start.lock'))
        marker = self.root / 'stopped'
        script = self.root / 'restart.sh'
        script.write_text(definitions + '\nverify_package() { return 0; }\nprepare_runtime() { return 1; }\nstop() { touch "' + str(marker) + '"; }\nstart() { return 0; }\ncase "${1:-start}" in' + dispatch)
        import os
        result = subprocess.run(['bash', str(script), 'restart'], env={**os.environ, 'MULMOTERM_PACKAGE': str(self.archive)}, capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(marker.exists())

    def test_launch_checks_before_executing_package(self):
        bin_dir = self.root / 'bin'
        bin_dir.mkdir()
        marker = self.root / 'executed'
        executable = bin_dir / 'mulmoterminal'
        executable.write_text('#!/bin/sh\ntouch "' + str(marker) + '"\n')
        executable.chmod(0o755)
        launch = (HERE / 'launch.sh').read_text().replace('$HOME/.local/libexec/mulmoterminal-guard/verify.py', str(HERE / 'verify.py'))
        script = self.root / 'launch.sh'
        script.write_text(launch)
        import os
        result = subprocess.run(['sh', str(script)], env={**os.environ, 'PATH': str(bin_dir) + ':' + os.environ['PATH']}, capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(marker.exists())


if __name__ == '__main__':
    unittest.main()
