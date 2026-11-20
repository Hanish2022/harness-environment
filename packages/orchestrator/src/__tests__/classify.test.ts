import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyIntent } from "../classify.js";

// Every case here is taken verbatim from the top-level project spec,
// section 10 ("Conversation Orchestrator"), so this test is really checking
// "does the classifier agree with the spec's own worked examples" — not
// cases I invented to make it look good.
test("spec section 10 worked examples", () => {
  assert.equal(classifyIntent("Payment service analyse karo.").type, "INSTRUCTION");
  assert.equal(classifyIntent("Doggie, kya progress hai?").type, "QUESTION");
  assert.equal(classifyIntent("Stop execution.").type, "AGENT_CONTROL");
  assert.equal(classifyIntent("Claude ne kya changes kiye?").type, "QUESTION");
  assert.equal(classifyIntent("Abhi koi command execute mat karna.").type, "AGENT_CONTROL");
});

test("English instructions", () => {
  assert.equal(classifyIntent("Analyze the payment service and explain the transaction flow.").type, "INSTRUCTION");
  assert.equal(classifyIntent("Refactor the auth middleware to use async/await.").type, "INSTRUCTION");
});

test("English questions", () => {
  assert.equal(classifyIntent("What is the current status?").type, "QUESTION");
  assert.equal(classifyIntent("How much progress have you made?").type, "QUESTION");
});

test("agent control phrases", () => {
  assert.equal(classifyIntent("Cancel that.").type, "AGENT_CONTROL");
  assert.equal(classifyIntent("Ruk jao, mat karo.").type, "AGENT_CONTROL");
  assert.equal(classifyIntent("Pause for a second.").type, "AGENT_CONTROL");
});

test("greetings and general conversation", () => {
  assert.equal(classifyIntent("Namaste Doggie!").type, "GENERAL");
  assert.equal(classifyIntent("Thanks, that's helpful.").type, "GENERAL");
  assert.equal(classifyIntent("").type, "GENERAL");
});

test("every classification reports which rule matched (no black-box verdicts)", () => {
  const intent = classifyIntent("Stop execution.");
  assert.ok(intent.matchedRule.length > 0);
});
