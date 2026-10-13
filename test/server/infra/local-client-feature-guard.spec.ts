import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { missingRequiredClientFeatures } from "../../../server/infra/local-client-feature-guard";

describe("local client feature guard", () => {
  it("reports missing review markers", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mt-guard-"));
    fs.mkdirSync(path.join(root, "assets"));
    fs.writeFileSync(path.join(root, "index.html"), 'name="mulmoterminal-feature-review-waiting"');
    fs.writeFileSync(path.join(root, "assets", "index.js"), "cell-review-badge cell-review-toggle review-toggle");
    expect(missingRequiredClientFeatures(root)).toEqual([]);
    fs.writeFileSync(path.join(root, "assets", "index.js"), "");
    expect(missingRequiredClientFeatures(root)).toEqual(["cell-review-badge", "cell-review-toggle", "review-toggle"]);
  });
});
