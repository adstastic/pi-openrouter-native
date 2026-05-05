import { test } from "node:test";
import assert from "node:assert/strict";
import { toPiModel } from "./index.ts";

test("returns undefined when id is missing", () => {
  assert.equal(toPiModel({}), undefined);
  assert.equal(toPiModel({ id: "" }), undefined);
  assert.equal(toPiModel({ id: 42 }), undefined);
});

test("falls back name to id when name missing or empty", () => {
  assert.equal(toPiModel({ id: "foo/bar" })?.name, "foo/bar");
  assert.equal(toPiModel({ id: "foo/bar", name: "" })?.name, "foo/bar");
  assert.equal(toPiModel({ id: "foo/bar", name: "Foo Bar" })?.name, "Foo Bar");
});

test("detects reasoning via supported_parameters", () => {
  for (const param of ["reasoning", "include_reasoning", "reasoning_effort"]) {
    const m = toPiModel({ id: "x/y", supported_parameters: [param] });
    assert.equal(m?.reasoning, true, `expected reasoning=true for ${param}`);
  }
});

test("detects reasoning via id pattern (DeepSeek r1, OpenAI o-series, gpt-5)", () => {
  for (const id of [
    "deepseek/deepseek-r1",
    "openai/o1-preview",
    "openai/o3-mini",
    "openai/o4",
    "openai/gpt-5",
  ]) {
    assert.equal(toPiModel({ id })?.reasoning, true, `expected reasoning=true for ${id}`);
  }
});

test("does NOT mark vanilla Qwen3 instruct as reasoning", () => {
  // Regression guard: Qwen3 ships both reasoning and non-reasoning variants;
  // the bare family name must not flip reasoning on without supported_parameters.
  assert.equal(toPiModel({ id: "qwen/qwen3-235b-instruct" })?.reasoning, false);
});

test("does NOT mark non-reasoning models as reasoning by accident", () => {
  for (const id of [
    "anthropic/claude-3.5-sonnet",
    "openai/gpt-4o",
    "google/gemini-2.0-flash",
    "meta-llama/llama-3.1-8b-instruct",
  ]) {
    assert.equal(toPiModel({ id })?.reasoning, false, `expected reasoning=false for ${id}`);
  }
});

test("detects image input via input_modalities", () => {
  const m = toPiModel({
    id: "x/y",
    architecture: { input_modalities: ["text", "image"] },
  });
  assert.deepEqual(m?.input, ["text", "image"]);
});

test("text-only when no image modality present", () => {
  assert.deepEqual(toPiModel({ id: "x/y" })?.input, ["text"]);
  assert.deepEqual(toPiModel({ id: "x/y", architecture: { input_modalities: ["text"] } })?.input, ["text"]);
});

test("multiplies prices by 1M and parses string-encoded values", () => {
  const m = toPiModel({
    id: "x/y",
    pricing: { prompt: "0.000003", completion: "0.000015" },
  });
  assert.equal(m?.cost.input, 3);
  assert.equal(m?.cost.output, 15);
});

test("non-positive or non-finite prices map to 0", () => {
  const m = toPiModel({
    id: "x/y",
    pricing: { prompt: "-1", completion: "garbage", input_cache_read: null },
  });
  assert.equal(m?.cost.input, 0);
  assert.equal(m?.cost.output, 0);
  assert.equal(m?.cost.cacheRead, 0);
});

test("cache pricing prefers input_cache_* and falls back to prompt_cache_*", () => {
  const a = toPiModel({
    id: "x/y",
    pricing: {
      input_cache_read: "0.000001",
      input_cache_write: "0.000002",
      prompt_cache_read: "0.000099",
    },
  });
  assert.equal(a?.cost.cacheRead, 1);
  assert.equal(a?.cost.cacheWrite, 2);

  const b = toPiModel({
    id: "x/y",
    pricing: { prompt_cache_read: "0.000001", prompt_cache_write: "0.000002" },
  });
  assert.equal(b?.cost.cacheRead, 1);
  assert.equal(b?.cost.cacheWrite, 2);
});

test("contextWindow falls back to 128k when missing or invalid", () => {
  assert.equal(toPiModel({ id: "x/y" })?.contextWindow, 128_000);
  assert.equal(toPiModel({ id: "x/y", context_length: 0 })?.contextWindow, 128_000);
  assert.equal(toPiModel({ id: "x/y", context_length: "garbage" })?.contextWindow, 128_000);
  assert.equal(toPiModel({ id: "x/y", context_length: 200_000 })?.contextWindow, 200_000);
});

test("maxTokens cascades top_provider → per_request_limits → 16_384", () => {
  assert.equal(
    toPiModel({ id: "x/y", top_provider: { max_completion_tokens: 32_000 } })?.maxTokens,
    32_000,
  );
  assert.equal(
    toPiModel({ id: "x/y", per_request_limits: { completion_tokens: 8_000 } })?.maxTokens,
    8_000,
  );
  // top_provider wins over per_request_limits when both present
  assert.equal(
    toPiModel({
      id: "x/y",
      top_provider: { max_completion_tokens: 32_000 },
      per_request_limits: { completion_tokens: 8_000 },
    })?.maxTokens,
    32_000,
  );
  assert.equal(toPiModel({ id: "x/y" })?.maxTokens, 16_384);
});
