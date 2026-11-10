"""Launcher regressions without contacting services or starting real agents."""
from pathlib import Path
import fcntl
import io
import os
import signal
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).parent
SOURCE = (HERE / 'mulmoterm').read_text()


def function(name):
    return name + '() {' + SOURCE.split(name + '() {', 1)[1].split('\n}', 1)[0] + '\n}'


class LauncherTest(unittest.TestCase):
    def listener_result(self, ipv4='', ipv6='', port=34567):
        code = function('port_listening').split("<<'PY'\n", 1)[1].split('\nPY', 1)[0]
        tables = {'/proc/net/tcp': ipv4, '/proc/net/tcp6': ipv6}
        def table_open(path):
            return io.StringIO('header\n' + tables[path])
        with patch('builtins.open', side_effect=table_open), patch.object(sys, 'argv', ['-', str(port)]):
            with self.assertRaises(SystemExit) as result:
                exec(compile(code, '<port_listening>', 'exec'), {})
        return result.exception.code

    def test_ipv4_listener(self):
        self.assertEqual(self.listener_result(ipv4='0: 0100007F:8707 00000000:0000 0A\n'), 0)

    def test_ipv6_listener(self):
        self.assertEqual(self.listener_result(ipv6='0: 00000000000000000000000000000000:8707 00000000000000000000000000000000:0000 0A\n'), 0)

    def test_connected_socket_is_not_a_listener(self):
        self.assertEqual(self.listener_result(ipv4='0: 0100007F:8707 00000000:0000 01\n'), 1)

    def test_other_port_and_empty_tables(self):
        self.assertEqual(self.listener_result(ipv4='0: 0100007F:8708 00000000:0000 0A\n'), 1)
        self.assertEqual(self.listener_result(), 1)

    def test_all_port_checks_use_proc_reader(self):
        for name, variable in [('listening', 'PORT'), ('proxy_listening', 'PROXY_PORT'), ('heatmap_listening', 'HEATMAP_PORT')]:
            self.assertIn(name + '() { port_listening "$' + variable + '"; }', SOURCE)

    def test_daemon_child_does_not_keep_startup_lock(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            daemon = root / 'codex'
            daemon.write_text('#!/bin/bash\nsleep 30 </dev/null >/dev/null 2>&1 &\necho $! > "$MOCK_PID"\n')
            daemon.chmod(0o700)
            lock = root / 'start.lock'
            pidfile = root / 'child.pid'
            script = function('ensure_codex_daemon') + '\nexec 9>"$MOCK_LOCK"\nflock -x 9\nensure_codex_daemon\n'
            env = {**os.environ, 'CODEX_BIN': str(daemon), 'MOCK_PID': str(pidfile), 'MOCK_LOCK': str(lock)}
            try:
                result = subprocess.run(['bash', '-c', script], env=env, capture_output=True, text=True, timeout=5)
                self.assertEqual(result.returncode, 0, result.stderr)
                pid = int(pidfile.read_text())
                os.kill(pid, 0)
                with lock.open('w') as handle:
                    fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            finally:
                if pidfile.exists():
                    try:
                        os.kill(int(pidfile.read_text()), signal.SIGTERM)
                    except ProcessLookupError:
                        pass


if __name__ == '__main__':
    unittest.main()
