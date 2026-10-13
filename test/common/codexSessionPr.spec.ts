import { describe, it, expect } from "vitest";
import { execCommandsIn, ghPrVerbs, codexPrFromExec } from "../../common/codexSessionPr.js";

// The input shapes are copied from real rollouts (2026-08-28), not invented. The BARE key is the
// one Codex actually writes; the quoted one is accepted because the same field has been seen both
// ways and requiring the quoted form found nothing at all, silently.
const bareKey = 'const r = await tools.exec_command({\n  cmd: "gh pr create --draft --base main --title \\"fix: x\\"",\n  workdir: "/w"\n}); text(r.output);';
const quotedKey = 'const r = await tools.exec_command({"cmd":"gh pr edit 1355 --add-label risk:high","workdir":"/w"}); text(r.output);';
const CREATED_OUTPUT = "Warning: 1 uncommitted change\nhttps://github.com/Nakaune/AidaNote/pull/1357\n";

describe("execCommandsIn", () => {
  it("reads the command out of either key form", () => {
    expect(execCommandsIn(bareKey)[0]).toBe('gh pr create --draft --base main --title "fix: x"');
    expect(execCommandsIn(quotedKey)[0]).toBe("gh pr edit 1355 --add-label risk:high");
  });

  it("reads every command of a batched call", () => {
    const batch = 'await Promise.all([tools.exec_command({cmd: "git status"}), tools.exec_command({cmd: "gh pr list"})]);';
    expect(execCommandsIn(batch)).toEqual(["git status", "gh pr list"]);
  });

  it("says nothing for input that is not a string or names no command", () => {
    expect(execCommandsIn(null)).toEqual([]);
    expect(execCommandsIn("const r = await tools.read_file({path: 'x'});")).toEqual([]);
  });
});

describe("ghPrVerbs", () => {
  it("splits writes from reads", () => {
    expect(ghPrVerbs(["gh pr create --draft", "gh pr list --json url"])).toEqual({ writes: ["create"], reads: ["list"] });
  });

  it("finds the verb inside a chain", () => {
    expect(ghPrVerbs(["git push -u origin HEAD && gh pr create --fill"]).writes).toEqual(["create"]);
  });

  it("ignores gh commands that are not about requests", () => {
    expect(ghPrVerbs(["gh issue list", "gh repo view"])).toEqual({ writes: [], reads: [] });
  });
});

describe("codexPrFromExec", () => {
  it("records a request the session opened", () => {
    expect(codexPrFromExec(bareKey, CREATED_OUTPUT, 1000)).toEqual({
      number: 1357,
      url: "https://github.com/Nakaune/AidaNote/pull/1357",
      repo: "Nakaune/AidaNote",
      created: true,
      at: 1000,
    });
  });

  it("records a request the session only changed", () => {
    const pr = codexPrFromExec(quotedKey, "https://github.com/Nakaune/AidaNote/pull/1355\n", 1000);
    expect(pr?.created).toBe(false);
    expect(pr?.number).toBe(1355);
  });

  // The property the whole module exists to keep. `gh pr list --json url` prints other people's
  // work, and recording it would answer the chip's question ("what did THIS session do") wrongly.
  it("says nothing for a call that only looked", () => {
    const listing = 'tools.exec_command({cmd: "gh pr list --json url --limit 20"});';
    const output = '[{"url":"https://github.com/Nakaune/AidaNote/pull/1354"},{"url":"https://github.com/Nakaune/AidaNote/pull/1357"}]';
    expect(codexPrFromExec(listing, output, 1000)).toBeNull();
  });

  // One `exec` call can run several commands and their output arrives as one blob, so a batch that
  // both created and listed cannot be attributed. Skipped rather than guessed at.
  it("says nothing for a batch that mixes a write with a read", () => {
    const mixed = 'await Promise.all([tools.exec_command({cmd: "gh pr create --fill"}), tools.exec_command({cmd: "gh pr list"})]);';
    expect(codexPrFromExec(mixed, CREATED_OUTPUT, 1000)).toBeNull();
  });

  it("says nothing when the command touched no request, or the output carries no url", () => {
    expect(codexPrFromExec('tools.exec_command({cmd: "git commit -m x"});', CREATED_OUTPUT, 1000)).toBeNull();
    expect(codexPrFromExec(bareKey, "Everything up-to-date\n", 1000)).toBeNull();
  });

  // The url goes into an <a href>, so http and javascript: must not reach it — same rule as
  // sessionPr.safeHttpsUrl, enforced here by the pattern itself.
  it("ignores a url that is not https", () => {
    // eslint-disable-next-line sonarjs/no-clear-text-protocols -- a cleartext url is the INPUT here; being refused is what the case asserts
    expect(codexPrFromExec(bareKey, "http://github.com/o/r/pull/12\n", 1000)).toBeNull();
  });

  it("reads a GitLab merge request too", () => {
    const pr = codexPrFromExec(bareKey, "https://gitlab.com/grp/proj/-/merge_requests/9\n", 1000);
    expect(pr?.number).toBe(9);
    expect(pr?.repo).toBe("grp/proj");
  });
});
