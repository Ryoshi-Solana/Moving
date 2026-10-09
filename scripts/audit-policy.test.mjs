import assert from "node:assert/strict";
import test from "node:test";
import { classifyAuditReport, KNOWN_BRACES_ADVISORY } from "./audit-policy.mjs";

const cleanLock = { packages: {} };
const bracesLock = {
  packages: {
    "node_modules/braces": { version: "3.0.3", dev: true },
  },
};

function bracesVulnerability(overrides = {}) {
  return {
    name: "braces",
    severity: "high",
    via: [
      {
        name: "braces",
        url: KNOWN_BRACES_ADVISORY,
      },
    ],
    nodes: ["node_modules/braces"],
    ...overrides,
  };
}

function bracesReport() {
  return { vulnerabilities: { braces: bracesVulnerability() } };
}

test("clean audit report passes", () => {
  assert.deepEqual(
    classifyAuditReport({ vulnerabilities: {} }, cleanLock),
    { status: "clean" },
  );
});

test("only the exact known dev-only braces advisory is warned and allowed", () => {
  assert.equal(
    classifyAuditReport(bracesReport(), bracesLock).status,
    "allowlisted-warning",
  );
});

test("transitive high findings are allowed only when every path leads to braces", () => {
  const names = ["braces", "micromatch", "chokidar", "tailwindcss"];
  const vulnerabilities = {
    braces: bracesVulnerability(),
    micromatch: {
      name: "micromatch",
      severity: "high",
      via: ["braces"],
      nodes: ["node_modules/micromatch"],
    },
    chokidar: {
      name: "chokidar",
      severity: "high",
      via: ["braces"],
      nodes: ["node_modules/chokidar"],
    },
    tailwindcss: {
      name: "tailwindcss",
      severity: "high",
      via: ["chokidar", "micromatch"],
      nodes: ["node_modules/tailwindcss"],
    },
  };
  const lockfile = {
    packages: Object.fromEntries(
      names.map((name) => [
        "node_modules/" + name,
        { version: name === "braces" ? "3.0.3" : "1.0.0", dev: true },
      ]),
    ),
  };
  assert.equal(
    classifyAuditReport({ vulnerabilities }, lockfile).status,
    "allowlisted-warning",
  );
});

test("the braces advisory is not allowed when braces is a production dependency", () => {
  const productionLock = {
    packages: {
      "node_modules/braces": { version: "3.0.3", dev: false },
    },
  };
  assert.equal(
    classifyAuditReport(bracesReport(), productionLock).status,
    "blocked",
  );
});

test("a different advisory on a transitive package fails", () => {
  const report = {
    vulnerabilities: {
      braces: bracesVulnerability(),
      micromatch: {
        name: "micromatch",
        severity: "high",
        via: ["braces", "other"],
        nodes: ["node_modules/micromatch"],
      },
    },
  };
  const lockfile = {
    packages: {
      "node_modules/braces": { version: "3.0.3", dev: true },
      "node_modules/micromatch": { version: "4.0.8", dev: true },
    },
  };
  assert.equal(classifyAuditReport(report, lockfile).status, "blocked");
});

test("any additional high/critical finding fails", () => {
  const report = bracesReport();
  report.vulnerabilities.other = {
    name: "other",
    severity: "critical",
    via: [{ name: "other", url: "https://example.com/advisory" }],
    nodes: ["node_modules/other"],
  };
  assert.equal(classifyAuditReport(report, bracesLock).status, "blocked");
});

test("unrecognized audit output fails closed", () => {
  assert.equal(classifyAuditReport(null, cleanLock).status, "blocked");
});
