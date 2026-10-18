# Public source snapshot

This branch contains the local MulmoTerminal 4.6 source changes as one commit
on the public upstream base. Private local commit history, deployment notes,
screenshots, session records and recovery archives are excluded. Personal paths,
project names and hostnames in examples and tests use placeholders.

The launcher defaults to `$HOME/project`; set `MULMOTERM_CWD` to your workspace.
The launch guard manifest describes an existing locally approved artifact.
Building this source does not automatically approve a new artifact: validate and
register its hashes before deployment, as described in
`scripts/local-launch-guard/OPERATIONS.md`.

Recovery snapshots remain local until a private offsite destination is configured.
Do not upload them to this public repository. Publish future source updates only
after reviewing the diff and outgoing history for private data.
