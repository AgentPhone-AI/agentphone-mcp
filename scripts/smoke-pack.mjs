#!/usr/bin/env node
/**
 * Smoke-test the PACKED tarball, not the source tree (tasks#195, finding 08).
 *
 * The npm 0.8.0 regression — detach_number returning {} from a 204 and failing
 * its output schema — only showed up in what was actually published, because the
 * fix lived on main. This packs the package exactly as `npm publish` would,
 * installs it into a clean throwaway directory, and runs the 204 detach
 * regression against the installed artifact:
 *
 *   - detachNumber must return { success: true } on a 204 No Content.
 *   - the installed package version must match package.json.
 *
 * Exits non-zero on any mismatch. Safe to run locally and in CI; makes no network
 * calls (fetch is stubbed) and touches only a temp dir it cleans up.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { createRequire } from "node:module";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const expectedVersion = require(join(root, "package.json")).version;

const workdir = mkdtempSync(join(tmpdir(), "agentphone-mcp-smoke-"));
let failed = false;
const fail = (msg) => { console.error(`  ✗ ${msg}`); failed = true; };
const pass = (msg) => console.log(`  ✓ ${msg}`);

try {
  console.log("Packing tarball (npm pack)...");
  const packOut = execFileSync("npm", ["pack", "--pack-destination", workdir], { cwd: root, encoding: "utf8" });
  const tarball = packOut.trim().split("\n").pop().trim();
  const tarballPath = join(workdir, tarball);
  console.log(`  packed ${tarball}`);

  console.log("Installing into a clean directory...");
  execFileSync("npm", ["init", "-y"], { cwd: workdir, stdio: "ignore" });
  execFileSync("npm", ["install", tarballPath], { cwd: workdir, stdio: "ignore" });

  const installed = join(workdir, "node_modules", "agentphone-mcp");

  // Version provenance: the installed package must be the version we think we are
  // releasing.
  const installedVersion = require(join(installed, "package.json")).version;
  if (installedVersion === expectedVersion) pass(`installed version ${installedVersion} matches package.json`);
  else fail(`installed version ${installedVersion} != package.json ${expectedVersion}`);

  // 204 detach regression, run against the INSTALLED dist (not src).
  const { AgentPhoneAPI } = await import(join(installed, "dist", "api.js"));
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, { status: 204 });
  try {
    const api = new AgentPhoneAPI("http://localhost:1", "test-key");
    const result = await api.detachNumber("agt_1", "num_1");
    if (result && result.success === true) pass("detachNumber returns { success: true } on a 204 from the packed artifact");
    else fail(`detachNumber returned ${JSON.stringify(result)} on a 204 (expected { success: true })`);
  } finally {
    globalThis.fetch = realFetch;
  }
} catch (e) {
  fail(`smoke test threw: ${e?.message ?? e}`);
} finally {
  try { rmSync(workdir, { recursive: true, force: true }); } catch {}
}

if (failed) {
  console.error("Packed-artifact smoke test FAILED.");
  process.exit(1);
}
console.log("Packed-artifact smoke test OK.");
