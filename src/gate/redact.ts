/**
 * Vendor-neutral summary redaction is duplicated on purpose: the gate must
 * remain independent from every harness integration.
 */
export function redactSummary(text: string, max = 200): string {
  const collapsed: string = text.replace(/\s+/g, " ").trim();
  const redactedTokens: string = collapsed.replace(
    /\b(?:sk-[A-Za-z0-9_-]+|ghp_[A-Za-z0-9_]+|AKIA[A-Z0-9]+)\b/g,
    "[redacted]",
  );
  const redactedBearer: string = redactedTokens.replace(
    /\bBearer\s+\S+/gi,
    "Bearer [redacted]",
  );
  const redactedAssignments: string = redactedBearer.replace(
    /\b(password|api_key|token)\s*=\s*[^\s,;]+/gi,
    "$1=[redacted]",
  );
  const limit: number = Math.max(0, Math.trunc(max));

  return redactedAssignments.length > limit
    ? `${redactedAssignments.slice(0, limit)}…`
    : redactedAssignments;
}
