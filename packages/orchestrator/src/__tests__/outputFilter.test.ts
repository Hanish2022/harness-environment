import { test } from "node:test";
import assert from "node:assert/strict";
import { filterAgentOutputForSpeech } from "../outputFilter.js";

// This is the real Kiro CLI output the user pasted from an actual live
// session — not a fixture I invented. If the filter handles this correctly,
// it handles the real case it was built for.
const REAL_KIRO_TRANSCRIPT = `• Cancelled
──────────────────────────────────────────────────────────────────────────────────────────────────
  okay okay we will wait for for

• Thought for 1s...
    ╰ They're confirming they'll wait for the device to reboot and re-sync. Just a brief
      acknowledgement needed, nothing more to do here.
• Sounds good. When 1460 is back up (or has had time to re-sync), ping me and I'll pull its fresh
  log to read the WSS 8084 result.

  Quick recap of what's parked, so nothing gets lost:
  - 1460 — allow=true set; waiting for reboot/re-sync → then I read the log (connected = was just
  gated off / error = local 8084 block).
  - 4111 / 3635 — also allow=true, same waiting; CONNACK test already pointed to local block.
  - 4634 vend-out — reboot to apply the 6.2 MB ad; test a vend.

  I'm here whenever you're ready.

▸ Credits: turn 0.47 • session 0.47 | Time: 10s

──────────────────────────────────────────────────────────────────────────────────────────────────
kiro_default · claude-opus-4.8 · ◔ 11%                                                ~/vol1/kiosk

›  ask a question or describe a task ↵`;

test("strips separator/box-drawing lines", () => {
  const out = filterAgentOutputForSpeech(REAL_KIRO_TRANSCRIPT);
  assert.ok(!out.includes("──"));
});

test("strips the 'Thought for Ns...' indicator and its rationale aside, including wrapped continuation lines", () => {
  const out = filterAgentOutputForSpeech(REAL_KIRO_TRANSCRIPT);
  assert.ok(!out.includes("Thought for"));
  assert.ok(!out.includes("╰"));
  assert.ok(!out.includes("They're confirming"));
  // Regression: the rationale aside wraps onto a second physical line with
  // no marker of its own ("acknowledgement needed, nothing more to do
  // here.") — a first version of this filter let that line leak through.
  assert.ok(!out.includes("acknowledgement needed"));
});

test("strips the credits footer and status bar chrome", () => {
  const out = filterAgentOutputForSpeech(REAL_KIRO_TRANSCRIPT);
  assert.ok(!out.includes("Credits:"));
  assert.ok(!out.includes("claude-opus-4.8"));
  assert.ok(!out.includes("ask a question or describe a task"));
});

test("strips a bare status word but keeps real bulleted content", () => {
  const out = filterAgentOutputForSpeech(REAL_KIRO_TRANSCRIPT);
  assert.ok(!out.includes("Cancelled"));
  assert.ok(out.includes("Sounds good"));
});

test("strips the echoed user instruction when given", () => {
  const out = filterAgentOutputForSpeech(REAL_KIRO_TRANSCRIPT, "okay okay we will wait for for");
  assert.ok(!out.includes("okay okay we will wait for for"));
});

test("keeps the actual reply content intact, in order", () => {
  const out = filterAgentOutputForSpeech(REAL_KIRO_TRANSCRIPT);
  assert.ok(out.includes("Sounds good. When 1460 is back up"));
  assert.ok(out.includes("Quick recap of what's parked"));
  assert.ok(out.includes("1460 — allow=true set"));
  assert.ok(out.includes("I'm here whenever you're ready"));
  // Order preserved: the recap must come after the opening line.
  assert.ok(out.indexOf("Sounds good") < out.indexOf("Quick recap"));
});

test("does not collapse more than one blank line in a row", () => {
  const out = filterAgentOutputForSpeech(REAL_KIRO_TRANSCRIPT);
  assert.ok(!out.includes("\n\n\n"));
});
