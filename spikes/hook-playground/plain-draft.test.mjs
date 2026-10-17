import test from "node:test";
import assert from "node:assert/strict";
import { createPlainDraft } from "./plain-draft.mjs";
import { initialState, exportScenario, importScenario } from "./model.mjs";
import { serializeDraft, parseDraft } from "./draft.mjs";

test("blank plain authoring exports only explicit metadata in the existing recipe envelope", () => {
  const metadata = { name: "  Café builders  ", ticker: "Build9" };
  const before = structuredClone(metadata);
  const envelope = createPlainDraft(metadata);
  assert.deepEqual(envelope, {
    schemaVersion: "repo-ing/hook-lab-recipe/1",
    template: "plain",
    recipe: { format: "hook-lab/1", coin: { name: "Café builders", ticker: "BUILD9" }, blocks: [] },
  });
  assert.deepEqual(metadata, before);
  assert.throws(() => importScenario(JSON.stringify(envelope)));
  assert.throws(() => parseDraft(JSON.stringify(envelope)));
});

test("metadata validates UTF-8 boundaries without truncation or invented defaults", () => {
  assert.equal(createPlainDraft({ name: "é".repeat(16), ticker: "a123456789" }).recipe.coin.name, "é".repeat(16));
  for (const name of ["", "   ", "é".repeat(16) + "a", "🙂".repeat(9), null, 123])
    assert.throws(() => createPlainDraft({ name, ticker: "A" }), error => error.field === "name");
  for (const ticker of ["", " A", "A ", "a1234567890", "é", "A_B", 1, null])
    assert.throws(() => createPlainDraft({ name: "New coin", ticker }), error => error.field === "ticker");
});

test("scenarios, backups, recipes and zero-valued rule extensions are refused, never projected to plain", () => {
  const state = initialState();
  state.connected.push("treasury", "governance", "safety");
  const scenario = exportScenario(state);
  const draft = serializeDraft({ state, selected: "curve", expert: true });
  const metadata = { name: "New coin", ticker: "NEW" };
  for (const input of [
    JSON.parse(scenario), JSON.parse(draft), createPlainDraft(metadata),
    { ...metadata, blocks: [] }, { ...metadata, blocks: [{ type: "creator_fee", fee_bps: 0 }] },
    { ...metadata, creatorFeeBps: 0 }, { ...metadata, customHook: null },
    { ...metadata, network: "mainnet-beta" }, { ...metadata, canSubmit: true },
    { ...metadata, virtualQuote: "30" }, { ...metadata, sourceScenario: state },
    null, [], "NEW", { name: "New coin" },
  ]) assert.throws(() => createPlainDraft(input));
  assert.equal(exportScenario(state), scenario);
  assert.equal(serializeDraft({ state, selected: "curve", expert: true }), draft);
});
