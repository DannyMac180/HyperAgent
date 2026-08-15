/**
 * Adapter-time correction/intervention detection (DAN-224).
 *
 * The store holds text digests only, so any signal that needs prose must be
 * computed here, at ingest, while the adapter momentarily holds the text.
 * Detection is deterministic (regex over the user turn plus two booleans of
 * vendor-supplied context) and deliberately conservative: a missed correction
 * costs one triage hint, a false positive poisons the signal downstream
 * narration quotes as recorded fact.
 *
 * Privacy: nothing here returns prose. The result is a boolean plus a closed
 * basis enum; callers must never copy the analyzed text into a payload.
 *
 * Vendor-blind: this module knows nothing about transcript formats. Adapters
 * supply `interrupted` (harness-recorded interrupt/abort evidence) and
 * `afterCompletionClaim` (the preceding agent turn claimed completion).
 */

export type CorrectionBasis =
  | "explicit_phrase"
  | "after_completion_claim"
  | "interrupt";

export interface CorrectionContext {
  /** The immediately preceding agent turn contained a completion claim. */
  afterCompletionClaim: boolean;
  /** The harness recorded this turn as (or right after) a user interrupt. */
  interrupted: boolean;
}

export interface CorrectionResult {
  isCorrection: boolean;
  basis: CorrectionBasis[];
}

/**
 * Phrases that read as a correction/redirection on their own, wherever the
 * turn sits. Each alternative is anchored on word boundaries and requires an
 * object or verb phrase — bare words ("no" mid-sentence, "wrong" as an
 * adjective elsewhere) must not trip it.
 */
const STRONG_PATTERNS: readonly RegExp[] = [
  // Leading flat negation or halt. Punctuation is required right after the
  // negation word ("No, use X", "nope — same failure") so ordinary leading
  // idioms ("No worries", "No rush on this") never fire. Same shape for
  // "stop"/"wait"/"wrong": a punctuated halt is a correction; the same word
  // opening an imperative or a compound noun ("Stop the dev server",
  // "Wrong-endian bytes") is not.
  /^(?:no|nope|nah)\s*[,.!:;—–-]/i,
  /^(?:no|nope|nah)$/i,
  // Unpunctuated leading negation counts only when the same clause reports a
  // failure ("Nope still got the same load failed error") — leading idioms
  // without failure vocabulary ("No worries if not") stay silent.
  /^(?:no|nope|nah)\b[^.!?\n]*\b(?:still|same|error|broken|fails?|failing|didn(?:'|’)?t|doesn(?:'|’)?t|wrong)\b/i,
  /^stop[.!,]/i,
  /^stop$/i,
  /^wait,/i,
  /^wrong[ ,.!:]/i,
  /^wrong$/i,
  // Direct wrongness claims about the agent's output.
  /\bthat(?:'|’)?s (?:wrong|incorrect|not right|not correct|not what)\b/i,
  /\bnot what i (?:asked|meant|wanted|said)\b/i,
  /\bthat(?:'|’)?s not (?:the|it|how|what)\b/i,
  // The agent's action was the problem. The why-question is verb-gated to
  // destructive acts — "why did you choose this library?" is a question, not
  // a correction.
  /\byou (?:broke|misunderstood|misread|ignored|missed|deleted|overwrote)\b/i,
  /\bwhy (?:did|would) you (?:delete|remove|change|rewrite|overwrite|revert|drop|skip|ignore)\b/i,
  // Explicit rollback requests.
  /\b(?:undo|revert) (?:that|this|those|it|the last|your)\b/i,
  /\bput (?:it|that|them) back\b/i,
  // The fix the agent shipped is not holding. Subject-gated so narrative
  // uses ("the previous version didn't work for them") stay silent.
  /\bstill (?:broken|failing|fails|wrong|not working)\b/i,
  /\b(?:it|that|this|still) (?:doesn(?:'|’)?t|didn(?:'|’)?t|does not|did not) work\b/i,
  /^(?:doesn(?:'|’)?t|didn(?:'|’)?t) work\b/i,
  /\bnot (?:fixed|working|what i)\b/i,
  // Re-asserting an instruction the agent missed. "I asked for X" alone is
  // often narrative ("I asked for access yesterday"), so only the direct
  // second-person forms count.
  /\bi (?:already )?(?:said|told you)\b/i,
  /\bi asked you to\b/i,
];

/**
 * Phrases that only read as a correction when the agent just claimed the work
 * was done — "still seeing the error" right after "fixed" is a correction;
 * the same words cold are often a plain status report.
 */
const AFTER_CLAIM_PATTERNS: readonly RegExp[] = [
  /\bstill (?:see|seeing|get|getting|got|shows?|showing|happens|happening|the same|an? error)\b/i,
  /\bnot quite\b/i,
  /\btry (?:that )?again\b/i,
  /\b(?:it|that) didn(?:'|’)?t\b/i,
  /\bactually[,:]/i,
  /\bare you sure\b/i,
];

function matchesAny(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern: RegExp): boolean => pattern.test(text));
}

/**
 * Phrase patterns scan only the leading window of the turn. Corrections lead
 * with the correction; harness-injected "user" turns and pasted content bury
 * matching phrases deep inside quoted material. Live-corpus sweep
 * (2026-08-15, 1,664 real user turns): full-text scan flagged 2.82% — almost
 * all machine-injected prompts quoting agent output — while a 300-char window
 * flagged 0.24%, all genuine interventions. Recall is unaffected in practice;
 * a pilot who opens with three hundred characters of prose before objecting
 * is the rare miss this trade accepts.
 */
const SCAN_WINDOW_CHARS = 300;

/**
 * Classify one real user turn. Deterministic; safe to call on every turn.
 * Returns `isCorrection: false` with an empty basis when nothing fires.
 */
export function detectCorrection(
  text: string,
  context: CorrectionContext,
): CorrectionResult {
  const basis: CorrectionBasis[] = [];
  const trimmed: string = text.trim().slice(0, SCAN_WINDOW_CHARS);

  if (context.interrupted) {
    basis.push("interrupt");
  }
  if (trimmed.length > 0 && matchesAny(trimmed, STRONG_PATTERNS)) {
    basis.push("explicit_phrase");
  }
  if (
    context.afterCompletionClaim &&
    trimmed.length > 0 &&
    matchesAny(trimmed, AFTER_CLAIM_PATTERNS)
  ) {
    basis.push("after_completion_claim");
  }

  return { isCorrection: basis.length > 0, basis };
}
