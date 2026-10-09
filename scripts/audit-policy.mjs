export const KNOWN_BRACES_ADVISORY =
  "https://github.com/advisories/GHSA-vfj7-8cjw-p6xm";

const GATED_SEVERITIES = new Set(["high", "critical"]);

/**
 * Gate high/critical audit findings, while temporarily allowing only the
 * known braces advisory if the exact vulnerable package is dev-only.
 * This is an audit-policy exception, not a claim that braces is patched.
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

  const lockedBraces = Object.entries(lockfile?.packages ?? {}).filter(
    ([path]) => path === "node_modules/braces" || path.endsWith("/node_modules/braces"),
  );

  const knownBracesOnly =
    gatedFindings.length === 1 &&
    gatedFindings[0][0] === "braces" &&
    gatedFindings[0][1]?.name === "braces" &&
    gatedFindings[0][1]?.severity === "high" &&
    Array.isArray(gatedFindings[0][1]?.via) &&
    gatedFindings[0][1].via.length === 1 &&
    gatedFindings[0][1].via[0]?.name === "braces" &&
    gatedFindings[0][1].via[0]?.url === KNOWN_BRACES_ADVISORY &&
    Array.isArray(gatedFindings[0][1]?.nodes) &&
    gatedFindings[0][1].nodes.length === 1 &&
    gatedFindings[0][1].nodes[0] === "node_modules/braces" &&
    lockedBraces.length === 1 &&
    lockedBraces[0][1]?.version === "3.0.3" &&
    lockedBraces[0][1]?.dev === true;

  if (knownBracesOnly) {
    return {
      status: "allowlisted-warning",
      reason:
        "Only the known GHSA-vfj7-8cjw-p6xm finding for braces@3.0.3 in development dependencies was reported.",
    };
  }

  return {
    status: "blocked",
    reason: `Unexpected high/critical dependency findings: ${gatedFindings
      .map(([name, vulnerability]) => `${name} (${vulnerability.severity})`)
      .join(", ")}.`,
  };
}
