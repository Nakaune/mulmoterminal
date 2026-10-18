import fs from "node:fs";
import path from "node:path";

const CLIENT_CANARY = 'name="mulmoterminal-feature-review-waiting"';
const BUNDLE_MARKERS = ["cell-review-badge", "cell-review-toggle", "review-toggle"];

export function missingRequiredClientFeatures(distDir: string): string[] {
  const missing: string[] = [];
  const index = path.join(distDir, "index.html");
  if (!fs.existsSync(index) || !fs.readFileSync(index, "utf8").includes(CLIENT_CANARY)) missing.push(CLIENT_CANARY);
  const assets = fs.existsSync(path.join(distDir, "assets")) ? fs.readdirSync(path.join(distDir, "assets")).filter((f) => f.endsWith(".js")) : [];
  const bundle = assets.map((f) => fs.readFileSync(path.join(distDir, "assets", f), "utf8")).join("\n");
  for (const marker of BUNDLE_MARKERS) if (!bundle.includes(marker)) missing.push(marker);
  return missing;
}

export function assertRequiredClientFeatures(distDir: string): void {
  const missing = missingRequiredClientFeatures(distDir);
  if (missing.length) throw new Error(`Local client build is missing required feature markers: ${missing.join(", ")}`);
}
