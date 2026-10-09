import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { classifyAuditReport } from "./audit-policy.mjs";

const audit = spawnSync("npm", ["audit", "--json"], {
  encoding: "utf8",
  maxBuffer: 10 * 1024 * 1024,
});

if (audit.error) {
  console.error("✘ Could not run npm audit:", audit.error.message);
  process.exit(1);
}

let report;
try {
  report = JSON.parse(audit.stdout);
} catch {
  console.error("✘ npm audit did not return valid JSON.");
  if (audit.stderr) console.error(audit.stderr.trim());
  process.exit(1);
}

if (![0, 1].includes(audit.status)) {
  console.error(`✘ npm audit exited unexpectedly with status ${audit.status}.`);
  if (audit.stderr) console.error(audit.stderr.trim());
  process.exit(1);
}

let lockfile;
try {
  lockfile = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
} catch (error) {
  console.error("✘ Could not read package-lock.json:", error.message);
  process.exit(1);
}

const result = classifyAuditReport(report, lockfile);

if (result.status === "clean") {
  if (audit.status !== 0) {
    console.error("✘ npm audit returned a failing status without a gated finding.");
    process.exit(1);
  }
  console.log("✔ No high/critical dependency advisories found.");
  process.exit(0);
}

if (result.status === "allowlisted-warning") {
  console.warn("⚠ Known upstream development-tool advisory remains unresolved.");
  console.warn(result.reason);
  console.warn(
    "This narrow exception does not mark the package as patched. The production-only audit must still pass, and any other high/critical finding fails CI.",
  );
  process.exit(0);
}

console.error("✘ Dependency security audit failed.");
console.error(result.reason);
if (audit.stderr) console.error(audit.stderr.trim());
process.exit(1);
