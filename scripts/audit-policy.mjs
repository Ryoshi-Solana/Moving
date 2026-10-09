export const KNOWN_BRACES_ADVISORY =
  "https://github.com/advisories/GHSA-vfj7-8cjw-p6xm";

const GATED_SEVERITIES = new Set(["high", "critical"]);

function isExactBracesAdvisory(vulnerability, lockfile) {
  const braceEntries = Object.entries(lockfile?.packages ?? {}).filter(
    ([path]) => path === "node_modules/braces" || path.endsWith("/node_modules/braces"),
  );

  return (
    vulnerability?.name === "braces" &&
    vulnerability?.severity === "high" &&
    Array.isArray(vulnerability?.via) &&
    vulnerability.via.length === 1 &&
    vulnerability.via[0]?.name === "braces" &&
    vulnerability.via[0]?.url === KNOWN_BRACES_ADVISORY &&
    Array.isArray(vulnerability?.nodes) &&
    vulnerability.nodes.length === 1 &&
    vulnerability.nodes[0] === "node_modules/braces" &&
    braceEntries.length === 1 &&
    braceEntries[0][1]?.version === "3.0.3" &&
    braceEntries[0][1]?.dev === true
  );
}

/* Trace npm audit's dependency graph to the exact approved root advisory. */
function traceOnlyKnownBraces(name, report, lockfile, stack = new Set(), chain = new Set()) {
  if (stack.has(name)) return false;
  chain.add(name);

  const vulnerability = report.vulnerabilities[name];
  if (!vulnerability) return false;

  if (name === "braces") {
    return isExactBracesAdvisory(vulnerability, lockfile);
  }

  if (!Array.isArray(vulnerability.via) || vulnerability.via.length === 0) {
    return false;
  }

  const nextStack = new Set(stack);
  nextStack.add(name);

  return vulnerability.via.every(
    (item) => typeof item === "string" &&
      traceOnlyKnownBraces(item, report, lockfile, nextStack, chain),
  );
}

function packagesAreDevOnly(names, lockfile) {
  for (const name of names) {
    const suffix = "/node_modules/" + name;
    const expectedPath = "node_modules/" + name;
    const entries = Object.entries(lockfile?.packages ?? {}).filter(
      ([path]) => path === expectedPath || path.endsWith(suffix),
    );

    if (entries.length === 0 || entries.some(([, pkg]) => pkg?.dev !== true)) {
      return false;
    }
  }
  return true;
}

/*
 * Gate high/critical audit findings, while temporarily allowing only the
 * known braces advisory if the lockfile confirms the entire affected chain
 * is development-only. This is not a claim that braces is patched.
 */
export function classifyAuditReport(report, lockfile) {
  if (
    !report ||
    typeof report !== "object" ||
    !report.vulnerabilities ||
    typeof report.vulnerabilities !== "object"
  ) {
    return {
      status: "blocked",
      reason: "npm audit did not return a recognizable JSON report.",
    };
  }

  const gatedFindings = Object.entries(report.vulnerabilities).filter(
    ([, vulnerability]) => GATED_SEVERITIES.has(vulnerability?.severity),
  );

  if (gatedFindings.length === 0) {
    return { status: "clean" };
  }

  const knownNames = new Set();
  const knownBracesOnly = gatedFindings.every(([name]) =>
    traceOnlyKnownBraces(name, report, lockfile, new Set(), knownNames),
  );

  if (knownBracesOnly && packagesAreDevOnly(knownNames, lockfile)) {
    return {
      status: "allowlisted-warning",
      reason:
        "All high/critical findings trace exclusively to GHSA-vfj7-8cjw-p6xm through development-only dependencies.",
    };
  }

  return {
    status: "blocked",
    reason: "Unexpected high/critical dependency findings: " +
      gatedFindings.map(([name, vulnerability]) =>
        name + " (" + vulnerability.severity + ")",
      ).join(", ") + ".",
  };
}
