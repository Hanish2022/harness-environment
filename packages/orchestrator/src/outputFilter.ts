/**
 * Strips known UI chrome from a wrapped agent's raw terminal output so what
 * gets SPOKEN is the actual conversational reply, not interface noise
 * (separator lines, "Thought for Ns..." indicators, credits/usage footers,
 * status-bar chrome, bare status words). The raw text is still shown
 * unfiltered in the terminal — this only changes what's spoken aloud.
 *
 * English only for now, by request — these are structural/symbol patterns
 * (bullets, box-drawing, known fixed phrases), not language-dependent, but
 * the rules below are tuned against one real agent's CLI (Kiro) conventions
 * observed during testing, not a general "works for any TUI" parser. A
 * different agent's output format would need its own rules.
 *
 * Deterministic, no LLM — consistent with the rest of this project's
 * orchestration (spec section 10).
 */

const SEPARATOR_LINE = /^[─━—=_\s]{4,}$/;
const CREDITS_LINE = /^▸\s*credits:/i;
const THOUGHT_INDICATOR_LINE = /^•\s*thought for\s+\d+s\.\.\.\s*$/i;
const RATIONALE_LINE = /^╰/;
const STATUS_WORD_LINE = /^•\s*(cancelled|interrupted|stopped|working|running|done)\s*$/i;
const STATUS_BAR_LINE = /^[\w.-]+\s*·.*·.*$/; // e.g. "kiro_default · claude-opus-4.8 · ◔ 11%"
const INPUT_PROMPT_LINE = /^›.*ask a question/i;
// A line made up entirely of box-drawing/block-element/braille characters
// (startup banners, ASCII-art logos, braille spinner frames) — unreadable
// as speech. Found live: a resumed session's startup banner/logo got read
// out loud verbatim alongside an actual answer.
const ASCII_ART_LINE = /^[\s─-▟⠀-⣿]+$/;

const NOISE_PATTERNS = [SEPARATOR_LINE, CREDITS_LINE, THOUGHT_INDICATOR_LINE, RATIONALE_LINE, STATUS_WORD_LINE, STATUS_BAR_LINE, INPUT_PROMPT_LINE, ASCII_ART_LINE];

export function filterAgentOutputForSpeech(rawText: string, spokenInstruction?: string): string {
  const instructionNormalized = spokenInstruction?.trim().toLowerCase();

  const lines = rawText.split("\n");
  const kept: string[] = [];
  // A "╰ rationale aside" wraps across multiple physical terminal lines with
  // no per-line marker on the continuation lines — found by testing against
  // a real transcript, where the wrapped second line leaked through as if it
  // were real content. Track block-skip state so the whole aside is dropped,
  // not just its first line.
  let skippingRationaleBlock = false;

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const trimmed = line.trim();

    if (trimmed === "") {
      skippingRationaleBlock = false; // a blank line always ends any block
      kept.push("");
      continue;
    }

    if (RATIONALE_LINE.test(trimmed)) {
      skippingRationaleBlock = true;
      continue;
    }
    if (skippingRationaleBlock) {
      if (!trimmed.startsWith("•")) continue; // still inside the wrapped aside
      skippingRationaleBlock = false; // a new bullet ends the block; handle it normally below
    }

    if (NOISE_PATTERNS.some((re) => re.test(trimmed))) continue;
    if (instructionNormalized && trimmed.toLowerCase() === instructionNormalized) continue;

    // Drop a leading "• " bullet from otherwise-real content so it reads as
    // plain prose rather than "bullet point sounds good" — list items using
    // "-" are left alone, those are meant to sound like a list.
    kept.push(trimmed.startsWith("• ") ? trimmed.slice(2) : line);
  }

  // Collapse runs of 2+ blank lines down to one, and trim the ends.
  return kept
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * The status-bar line (e.g. "kiro_default · claude-opus-4.8 · ◔ 16%
 * ~/vol1/kiosk") is deliberately stripped as noise by the filter above — it's
 * not part of a conversational reply. But it's also the only place the
 * current working directory, model, and context usage actually show up, so
 * when someone explicitly asks a status-type question ("what directory are
 * you in?"), that's the one piece of chrome worth surfacing on purpose.
 */
export function extractStatusLine(rawText: string): string | null {
  for (const rawLine of rawText.split("\n")) {
    const trimmed = rawLine.trim();
    if (STATUS_BAR_LINE.test(trimmed)) return trimmed;
  }
  return null;
}
