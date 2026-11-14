import assert from "node:assert/strict";
import test from "node:test";
import { markKeyOf } from "./markKey";

test("a provider id gets that provider's own mark", () => {
  assert.equal(markKeyOf("claude-code"), "claude-code");
  assert.equal(markKeyOf("api"), "anthropic");
  assert.equal(markKeyOf("codex"), "codex");
  assert.equal(markKeyOf("copilot"), "copilot");
});

test("a model id gets its vendor's mark", () => {
  assert.equal(markKeyOf("claude-sonnet-5-5"), "claude");
  assert.equal(markKeyOf("gpt-5.1"), "openai");
  assert.equal(markKeyOf("o3-mini"), "openai");
  assert.equal(markKeyOf("openai/gpt-5-mini"), "openai");
  assert.equal(markKeyOf("deepseek/deepseek-v4.1-flash"), "deepseek");
  assert.equal(markKeyOf("meta-llama/llama-4"), "meta");
  assert.equal(markKeyOf("moonshotai/kimi-k3"), "kimi");
  assert.equal(markKeyOf("z-ai/glm-5"), "zhipu");
  assert.equal(markKeyOf("qwen3-coder"), "qwen");
  assert.equal(markKeyOf("Gemini-3-pro"), "gemini");
});

test("ids with no vendor mark, and our own router, have none", () => {
  assert.equal(markKeyOf("router"), null);
  assert.equal(markKeyOf("factory-droid"), null);
  assert.equal(markKeyOf("oh-my-pi"), null);
  assert.equal(markKeyOf("copilot-model-1"), null);
  assert.equal(markKeyOf("opus"), null);
  assert.equal(markKeyOf(""), null);
  assert.equal(markKeyOf("o"), null);
});
