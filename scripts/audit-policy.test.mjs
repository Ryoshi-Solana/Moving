import assert from "node:assert/strict";
import test from "node:test";
import { classifyAuditReport, KNOWN_BRACES_ADVISORY } from "./audit-policy.mjs";

const cleanLock = { packages: {} };
const bracesLock = {
  packages: {
    "node_modules/braces": { version: "3.0.3", dev: true },
  },
};

function bracesReport(overrides = {}) {
  return {
    vulnerabilities: {
      braces: {
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
      },
    },
  };
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

test("a different high-severity advisory fails", () => {
  const report = {
    vulnerabilities: {
      braces: {
        name: "braces",
        severity: "high",
        via: [{ name: "braces", url: "https://example.com/other-advisory" }],
        nodes: ["node_modules/braces"],
      },
    },
  };
  assert.equal(classifyAuditReport(report, bracesLock).status, "blocked");
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
