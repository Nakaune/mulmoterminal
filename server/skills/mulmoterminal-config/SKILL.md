---
name: mulmoterminal-config
description: The way into configuring MulmoTerminal, and the way to find out how it is configured now. Use for a broad or unsure request — "configure MulmoTerminal", "set this up", "customize this", "what can I change?", first-run setup — and route to the skill that owns the area. Also answers "how is this set up right now?", "why isn't my setting working?", "did that take effect?" by reading the live config: the global `~/.mulmoterminal/config.json`, each project's `.mulmoterminal.json`, and what the app ACTUALLY parsed from them — including keys it dropped in validation, which is the difference between a setting you never made and one that silently never applied. Owns the global settings that have no skill of their own: work comments on an issue (issueWorkComments), the PR clone footer (prWorkdirFooter), the closing summary (appendSystemPrompt), the decision digest (decisionDigest), the periodic dev-work log (worklogEnabled), roster row length (cockpitLines), a self-hosted GitLab (gitlabHosts), and a project's Skill menu (skills). When the request names another area, go straight to that skill instead: mulmoterminal-dirs (colours, grid order, project names, font size), mulmoterminal-theme (your own colour scheme), mulmoterminal-header (buttons and chips), mulmoterminal-keys (shortcuts, copy-on-select, Enter behaviour), mulmoterminal-model (other models and backends, and your own command for starting Claude Code), mulmoterminal-notify (sounds and push).
---

# Configuring MulmoTerminal — start here

This skill does two things: it **routes** to whichever skill owns what the user wants, and it
**reports** on how things are configured right now. Anything that writes a setting lives in a
sibling skill.

## Where settings live

| Place | What | Written by |
|---|---|---|
| Settings modal | Theme, terminal font size / family / scroll, roster rows, notification sounds, Push, PR repos, self-hosted GitLab, work comments, PR footer, closing summary, decision digest, dev-work log, copy-on-select, Enter behaviour, launch commands, phone quick commands, MCP servers | the user, in the UI |
| `~/.mulmoterminal/config.json` | Everything global — including the five Settings can only SHOW, never edit: `keymap`, `themes`, `providers`, `customAgents`, `buttons` / `chips` | these skills, or by hand |
| `<project>/.mulmoterminal.json` | Per-project appearance and behaviour. **No UI writes this file** | these skills only |

**Check Settings first when a request is one setting.** Most global settings now have a control
there, so "turn on work comments" is a click rather than a skill run — say where it is and let them
choose. The five above are the exception: a keymap binding, a colour scheme, a backend, your own
Claude Code command, a header button. Settings SHOWS each of them — what is configured now, and for
a backend whether it can be reached — but cannot edit them: they are structured enough to need the
questions a skill asks. Every one of those sections carries a button that launches the owning skill.

## Routing

Ask what they want to change — one `AskUserQuestion`, concrete options — then invoke that skill and
carry on there. Do not re-explain its contents here; the sibling skill is the source of truth.

| They want | Skill |
|---|---|
| Colours for a project, colour-coding several, grid/launcher order, a name badge, a project icon image, terminal font size or font | `mulmoterminal-dirs` |
| Their **own** colour scheme, appearing in Settings' picker | `mulmoterminal-theme` |
| Header buttons or info chips, globally or per project | `mulmoterminal-header` |
| Keyboard shortcuts, copy-on-select, Enter vs. newline | `mulmoterminal-keys` |
| Another model or backend (OpenRouter, a gateway, a per-project model) | `mulmoterminal-model` |
| Their **own command** for starting Claude Code (`ollama launch claude …`, a wrapper script), offered in the Agent Picker | `mulmoterminal-model` |
| Which moments beep or push, and what they play | `mulmoterminal-notify` |
| Work comments on an issue, the PR clone footer, the closing summary, the decision digest, the dev-work log, roster row length, a self-hosted GitLab | **stay here** — [the settings that live here](#the-settings-that-live-here) |
| Something is broken and they don't know which setting | **Audit first** (below), then route |

If the request already names an area, skip the question. "Make this project blue" goes straight to
`mulmoterminal-dirs`.

**"I want to add my own agent" is two different requests**, and the answer differs by which one:
an entry in the **Agent Picker** that runs Claude Code through the user's command line and receives
Claude Code's arguments (`customAgents` → `mulmoterminal-model`), or a **launcher chip** that runs a
command verbatim with nothing added and no session (`launchers` → Settings' *Launch commands*, which
has a UI and so needs no skill). Ask which before routing: they sit side by side in the launcher and
behave in opposite ways.

Some requests span two skills, and that is normal — say so and do them in order. "Give my new repo
the same look as the others, in my own theme" is `mulmoterminal-theme` (define it once) then
`mulmoterminal-dirs` (pin it and set the colours).

## Audit — how is it configured now?

Reach for this when the user asks what their setup looks like, or says a setting "isn't working".
**Read; do not fix anything until you have reported and they have chosen.**

### 1. The global config

```sh
curl -s "http://localhost:${MULMOTERMINAL_PORT:-34567}/api/config"
```

Falling back to reading `~/.mulmoterminal/config.json` directly is fine, but say which you used.

### 2. Each project

Take `cwdPresets` from the global config — the directories the user actually opens — and for each:

```sh
curl -sG "http://localhost:${MULMOTERMINAL_PORT:-34567}/api/dir-config-detail" --data-urlencode "cwd=$path"
```

Let `curl` encode `cwd` (`-G` + `--data-urlencode`). Interpolating the path raw truncates at the
first `#` or `?` and mangles spaces, and a directory named that way is exactly the one someone
reaches for this audit about.

**Use this route rather than reading the file.** It returns what the app *actually parsed*: the
values in force, which keys the file set, and how each fared — **applied**, **dropped in
validation**, or **not a key we read**. Reading the file tells you what it says; only this tells you
what is in effect, and that gap is the entire content of "I set it and nothing happened". It also
resolves paths the way the app does, so a preset whose project was deleted answers as missing
instead of silently reporting on some other directory.

### 3. Report

Lead with **what is not in effect**, because that is what the user is asking about even when they
phrase it as a general question:

- **Dropped keys** — set in the file, rejected by validation. Name the key, the value, and why.
  For the global config there is no route that reports this: `/api/config` answers the SANITIZED
  config, so an entry present in `~/.mulmoterminal/config.json` and absent from that response is
  precisely one that was dropped. Compare the two whenever a global list (`providers`,
  `customAgents`, `launchers`, `themes`) is shorter than the user expects.
- **Unrecognised keys** — typos survive on purpose (`copyOnSlect` is kept, not deleted), which is
  what makes them findable. Say so; a kept key is not a working one.
- **Set but invisible** — a real setting doing nothing yet. The common ones:
  - `orderPriority` while the grid's ordering button is on auto or manual (the launcher's chips
    still use it).
  - Chrome colours while a session is busy or waiting — the working/attention colours take over,
    and the configured ones only show when the cell is idle.
  - A global change that needs a **tab reload**, or `fontFamily` / a provider key, which need a
    **server restart**.
- **Then** the settings that are working, grouped by area, briefly.

Offer to fix what you found, and route to the owning skill for anything they pick.

## Rules every one of these skills follows

State these when they matter; they are the ones that cost people an afternoon.

- **Global writes are a partial `POST /api/config` merge.** Write only the keys you are changing.
  Arrays (`themes`, `providers`, `buttons`, `chips`, `soundKinds`) **replace** rather than append —
  send them complete, or you delete the rest.
- **`<project>/.mulmoterminal.json` applies live, and writing it with your Write/Edit tool is
  itself the reload signal.** There is **no filesystem watcher**: a file the user edits by hand does
  nothing until something re-reads it. Always write it yourself rather than asking them to.
- **Read the existing file and merge before writing.** Never drop keys the user did not ask to
  change — these files are shared between skills.
- **Malformed values are silently dropped**, so an invalid field just never takes effect. Check with
  the audit above rather than assuming a write landed.
- **When it takes effect**: per-project → immediately. Most global → **reload the tab**.
  `fontFamily`, provider keys, and any hand-edit made while the server is running → **restart the
  server**.

## The settings that live here

None is big enough to warrant its own skill. **All but `skills` also have a Settings control** — offer that first, and use these when the user would rather be told the key, or is
setting up a machine without opening the browser.

### `skills` — the header's Skill menu, per project

The header's **Skill** dropdown lists a directory's Claude skills (`.claude/skills`, user +
project scope) and runs the one picked. `skills` is an **allowlist that also sets the order**: an
array (≤ 100) of slugs — only these appear, in this order. **Omit the key** to show every discovered
skill (working-directory ones first). Slugs that don't resolve are ignored.

```json
{ "skills": ["review-diff", "commit-msg"] }
```

### `appendSystemPrompt` — the closing summary

Every session is asked to end a reply with a short summary of what was asked, what was achieved and
what was not, under a `---` rule. It exists for the grid: coming back to a cell later, that is
otherwise only recoverable by scrolling the whole session.

```json
{ "appendSystemPrompt": false }
```

- **On by default**; only an explicit `false` turns it off. Set it globally in
  `~/.mulmoterminal/config.json`, or per project — **the project wins**.
- **Nothing in the app reads what the summary says.** Turning it off costs no feature; the roster's
  "last reply" and push notifications just become the raw tail of the reply.
- Applies to sessions started **from then on**. No restart, but a running session keeps what it
  launched with — reopen the cell.
- `true` / `false` only. There is **no way to substitute custom wording** — do not offer one.
- Independent of `prWorkdirFooter`: both ride on `--append-system-prompt`, and turning one off
  leaves the other.

### `gitlabHosts` — a GitLab of your own

The cross-repo **PRs & Issues** view reads github.com with `gh` and gitlab.com with `glab`. A
self-hosted GitLab cannot be recognised from its address — nothing in `gitlab.example.com` says
which forge runs there — so it is declared:

```json
{
  "gitlabHosts": ["gitlab.example.com"],
  "prRepos": ["gitlab.example.com/group/project"]
}
```

- A declared host then does everything gitlab.com does: the list, starting work from an issue, work
  comments, opening a merge request.
- **`glab` must be logged in to it**: `glab auth login --hostname gitlab.example.com`. Check with
  `glab auth status` — this app holds no token of its own.
- **Hostnames only.** A project path, a port, or a value that is not a hostname is dropped on load,
  which looks exactly like never having written it — audit with `/api/config` rather than assuming.
- Global only, and it takes effect on the **next server start** either way — a hand edit and the
  Settings control are the same write.
- Until a host is declared, its row in the view says so and names this key.

### `issueWorkComments` — telling an issue you are on it

A cell comments **once** on the issue it is working on: posted when the work starts, then **edited**
as the PR opens and merges (closing the issue if the forge has not already). It names the working
**directory** — the folder name only, never the path — so a reader can tell which clone, and two
terminals do not start the same issue twice.

```json
{ "issueWorkComments": true }
```

- **Off by default**, and this is the one setting here that writes to somebody else's repo. Ask
  before turning it on for someone.
- Needs `gh` (or `glab` for a GitLab host) logged in. This app holds no token of its own.
- CI is deliberately never reported: it is on the PR already, and it flaps.

### `prWorkdirFooter` — which clone made this PR

Ends a created PR's body with `work in <clone name>`, so a PR says which of several side-by-side
clones produced it.

```json
{ "prWorkdirFooter": false }
```

- **On by default**; only an explicit `false` turns it off. Independent of `appendSystemPrompt`
  despite both riding on `--append-system-prompt`.

### `decisionDigest` — what this project already decided

Keeps a Markdown digest of the decisions this project's sessions asked for, refreshed on a timer,
for an agent to read before asking something similar.

```json
{ "decisionDigest": true }
```

- **Off by default**: it writes a file (under `~/.mulmoterminal/decisions/`) that would otherwise
  never exist. `mulmoterminal-decisions` is what READS and curates it; this key is the switch.

### `worklogEnabled` / `worklogIntervalHours` — the periodic dev-work log

A built-in scheduled task that summarizes recent work across the saved working dirs into weekly
wiki pages.

```json
{ "worklogEnabled": true, "worklogIntervalHours": 6 }
```

- **Off by default, and it costs tokens** — each run spawns an LLM session. Say so before enabling.
- The interval is whole hours, clamped to 1–168. Anything else falls back to 6.

### `toolbarLinks` — links pinned beside the notification bell

Pages you want one click away from anywhere in the app. They render as icon buttons in the app
toolbar, immediately LEFT of the notification bell.

```json
{
  "toolbarLinks": [
    { "label": "開発ヒートマップ", "url": "http://localhost:34567/htmlfile/abs/home/me/heatmap.html", "icon": "calendar_month" }
  ]
}
```

- **Not a `launcher`.** Those START A CELL — a link put there costs a terminal to open a page.
  Not a header `button` either: those live on one terminal and are scoped with `when`. This is app
  chrome, with no session and no directory behind it.
- `icon` is a Material Symbols name. Omit it and the link gets a generic glyph rather than a blank
  30px gap.
- `url` must be `http:` or `https:`. Anything else is dropped on save — an href is the one field
  here that can run code.
- At most 6, labels unique. The toolbar is a fixed row shared with the view buttons and the gauges.
- No Settings control writes these: name them in `config.json`, or POST to `/api/config`.

### `cockpitLines` — how long a roster row is

How many lines each row of the cockpit roster (the list beside an enlarged cell) shows before it
clamps. Defaults to 2 / 2 / 3.

```json
{ "cockpitLines": { "summary": 4, "prompt": 2, "response": 3 } }
```

- One field per line because they are worth different amounts: a summary says what a session is
  doing NOW, while a prompt is usually done in two lines.
- Each is clamped to 1–20, **per field**, so one bad value cannot discard the two set correctly.
- Raising these trades how many sessions fit on screen for reading a long one in place. It is a
  trade the user makes — do not "fix" a clamped row by raising it unasked.
