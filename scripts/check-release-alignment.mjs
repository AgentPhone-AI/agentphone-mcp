#!/usr/bin/env node
/**
 * Fail if the version is not identical across every place that declares it, so a
 * release can never ship a package.json, registry manifest, and runtime
 * handshake that disagree (tasks#195, finding 08).
 *
 * Sources checked:
 *   - package.json "version"
 *   - server.json "version" and packages[].version (MCP registry manifest)
 *   - the built handshake version in dist/index.js (derived from package.json;
 *     this guards against a stale build being published)
 *
 * Run it in CI and from prepublishOnly. It reads the built output, so run it
 * after `npm run build`.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => JSON.parse(readFileSync(join(root, p), "utf8"));

const problems = [];
const pkg = read("package.json");
const expected = pkg.version;
if (!expected) problems.push("package.json has no version");

// server.json (optional, but if present it must agree). A missing file is fine;
// a malformed or unreadable one is a real problem and must not be treated as
// "absent" (that would silently skip the registry-version checks).
let server;
try {
  server = read("server.json");
} catch (error) {
  if (error?.code === "ENOENT") server = null;
  else problems.push(`server.json could not be read: ${error?.message ?? error}`);
}
if (server) {
  if (server.version !== expected) {
    problems.push(`server.json version ${server.version} != package.json ${expected}`);
  }
  for (const p of server.packages ?? []) {
    if (p.version !== expected) {
      problems.push(`server.json packages[${p.identifier ?? "?"}].version ${p.version} != ${expected}`);
    }
  }
}

// Built handshake version: the string the server reports over MCP. It is derived
// from package.json at runtime, so the build must (a) still derive it that way and
// (b) not reintroduce a hardcoded version literal that could drift.
let built;
try {
  built = readFileSync(join(root, "dist/index.js"), "utf8");
} catch {
  problems.push("dist/index.js not found — run `npm run build` before this check");
}
// Check with `!== undefined` so an empty dist/index.js (falsy, but present) still
// fails rather than silently skipping provenance validation.
if (built !== undefined) {
  if (!/createRequire\(import\.meta\.url\)\(["']\.\.\/package\.json["']\)/.test(built)) {
    problems.push("dist/index.js no longer derives VERSION from package.json (possible hardcoded version)");
  }
  // Guard against a reintroduced literal like `VERSION = "0.9.0"` that would
  // bypass the single-source-of-truth derivation above.
  const hardcoded = built.match(/\bVERSION\s*=\s*["'`]\d+\.\d+\.\d+[^"'`]*["'`]/);
  if (hardcoded) {
    problems.push(`dist/index.js assigns a hardcoded version (${hardcoded[0]}); VERSION must come from package.json`);
  }
}

if (problems.length) {
  console.error("Release version alignment FAILED:");
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`Release version alignment OK: ${expected} across package.json${server ? ", server.json" : ""}, and the built handshake.`);
