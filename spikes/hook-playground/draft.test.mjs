import test from "node:test";
import assert from "node:assert/strict";
import { initialState, simulate } from "./model.mjs";
import {
  createDraftStore,
  DRAFT_KEY,
  parseDraft,
  serializeDraft,
} from "./draft.mjs";

const draft = () => ({
  state: initialState(),
  selected: "curve",
  expert: false,
});
const storage = () => {
  const data = new Map();
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value),
  };
};

test("drafts restore incomplete edits and view without treating them as runnable", () => {
  const disk = storage(),
    store = createDraftStore(() => disk),
    value = draft();
  value.state.values.reserve = null;
  value.state.values.share = 125;
  value.expert = true;
  value.selected = "treasury";
  assert.equal(store.load().status, "empty");
  assert.equal(store.save(value).status, "saved");
  const restored = createDraftStore(() => disk).load();
  assert.deepEqual(restored.draft, value);
  assert.ok(simulate(restored.draft.state).errors.length);
  assert.deepEqual(parseDraft(serializeDraft(value)), value);
});
test("corrupt and future drafts remain recoverable until explicitly replaced", () => {
  for (const raw of [
    "{",
    '{"format":"future/2"}',
    JSON.stringify({
      ...JSON.parse(serializeDraft(draft())),
      state: { connected: ["custom"], values: {} },
    }),
  ]) {
    const disk = storage();
    disk.setItem(DRAFT_KEY, raw);
    const store = createDraftStore(() => disk);
    assert.equal(store.load().status, "unreadable");
    assert.equal(store.save(draft()).status, "blocked");
    assert.equal(store.raw(), raw);
    assert.equal(store.replace(draft()).status, "saved");
    assert.deepEqual(store.load().draft, draft());
  }
});
test("a stale tab cannot overwrite another tab, including without a storage event", () => {
  const disk = storage(),
    first = createDraftStore(() => disk),
    second = createDraftStore(() => disk);
  first.load();
  second.load();
  const changed = draft();
  changed.state.values.reserve = 73;
  first.save(changed);
  assert.equal(second.save(draft()).status, "conflict");
  assert.deepEqual(parseDraft(second.raw()), changed);
  assert.equal(second.save(draft()).status, "blocked");
  assert.deepEqual(second.load().draft, changed);
  assert.equal(second.save(changed).status, "saved");
});
test("storage denial and quota errors report unsaved data, not success", () => {
  const denied = createDraftStore(() => {
    throw new Error("denied");
  });
  assert.equal(denied.load().status, "unavailable");
  assert.equal(denied.replace(draft()).status, "unavailable");
  const disk = storage(),
    store = createDraftStore(() => disk);
  store.load();
  disk.setItem = () => {
    throw new Error("quota");
  };
  assert.equal(store.save(draft()).status, "unavailable");
  assert.equal(disk.getItem(DRAFT_KEY), null);
});
