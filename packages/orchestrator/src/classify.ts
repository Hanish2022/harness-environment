export type IntentType = "INSTRUCTION" | "QUESTION" | "AGENT_CONTROL" | "GENERAL";

export interface Intent {
  type: IntentType;
  /** What specifically matched, for debugging/transparency — never hidden from the user. */
  matchedRule: string;
}

/**
 * Deterministic, keyword/pattern-based intent classification — spec section
 * 10 explicitly asks for this instead of another paid LLM call. Covers
 * English, Hindi (Devanagari), and Hinglish (romanized Hindi), since that's
 * the stated target audience. This is necessarily a blunt instrument
 * (no model behind it): ambiguous phrasing will sometimes land in the wrong
 * bucket. Order matters — checked most-specific-first.
 */

const AGENT_CONTROL_PATTERNS: Array<{ re: RegExp; rule: string }> = [
  { re: /\bstop( execution)?\b/i, rule: "stop/stop execution" },
  { re: /\b(cancel|abort|interrupt)\b/i, rule: "cancel/abort/interrupt" },
  { re: /\bruk(o|iye|na)?\b|\bruk jao\b/i, rule: "ruko/ruk jao (Hindi: stop)" },
  { re: /mat karo\b|mat karna\b|\bna karo\b/i, rule: "mat karo/mat karna (Hindi: don't do)" },
  { re: /\bpause\b/i, rule: "pause" },
];

const QUESTION_PATTERNS: Array<{ re: RegExp; rule: string }> = [
  { re: /\bdoggie\b.*\?\s*$/i, rule: "addressed to Doggie + trailing '?'" },
  { re: /\b(what|how|why|when|where)\b.*\?\s*$/i, rule: "English wh-question" },
  { re: /\b(kya|kaisa|kitna|kab|kahan|kaun)\b/i, rule: "Hindi/Hinglish question word (kya/kaisa/kitna/...)" },
  { re: /\?\s*$/, rule: "trailing question mark" },
  { re: /\b(progress|status|update)\b.*\?/i, rule: "asking for progress/status" },
];

const GENERAL_PATTERNS: Array<{ re: RegExp; rule: string }> = [
  { re: /^(hi|hello|hey|namaste|good (morning|evening|night))\b/i, rule: "greeting" },
  { re: /^(thanks|thank you|shukriya|dhanyavaad)\b/i, rule: "thanks" },
  { re: /^(bye|goodbye|alvida)\b/i, rule: "farewell" },
];

export function classifyIntent(text: string): Intent {
  const trimmed = text.trim();
  if (!trimmed) return { type: "GENERAL", matchedRule: "empty input" };

  for (const { re, rule } of AGENT_CONTROL_PATTERNS) {
    if (re.test(trimmed)) return { type: "AGENT_CONTROL", matchedRule: rule };
  }
  for (const { re, rule } of QUESTION_PATTERNS) {
    if (re.test(trimmed)) return { type: "QUESTION", matchedRule: rule };
  }
  for (const { re, rule } of GENERAL_PATTERNS) {
    if (re.test(trimmed)) return { type: "GENERAL", matchedRule: rule };
  }
  return { type: "INSTRUCTION", matchedRule: "default (no control/question/greeting pattern matched)" };
}
