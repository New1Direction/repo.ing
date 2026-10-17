import { modules, validateDraft } from "./model.mjs";

export const DRAFT_KEY = "repo.ing:hook-playground:draft:1";

export function serializeDraft(draft) {
  const errors = validateDraft(draft.state);
  if (
    errors.length ||
    typeof draft.selected !== "string" ||
    !Object.hasOwn(modules, draft.selected) ||
    typeof draft.expert !== "boolean"
  )
    throw new Error("This draft contains unsupported settings.");
  return JSON.stringify({
    format: "repoing-playground-draft/1",
    simulationOnly: true,
    ...draft,
  });
}

export function parseDraft(raw) {
  if (typeof raw !== "string" || raw.length > 32768)
    throw new Error("Draft exceeds the 32 KB limit.");
  const data = JSON.parse(raw);
  if (
    !data ||
    data.format !== "repoing-playground-draft/1" ||
    data.simulationOnly !== true ||
    Object.keys(data).some(
      (key) =>
        !["format", "simulationOnly", "state", "selected", "expert"].includes(
          key,
        ),
    )
  )
    throw new Error("Unsupported draft format.");
  const draft = {
    state: data.state,
    selected: data.selected,
    expert: data.expert,
  };
  serializeDraft(draft);
  return draft;
}

// Never overwrite unreadable data or another tab's newer save. The caller must
// explicitly reload or replace the saved draft before automatic writes resume.
export function createDraftStore(getStorage = () => localStorage) {
  let baseline,
    blocked = true;
  return {
    load() {
      baseline = undefined;
      try {
        baseline = getStorage().getItem(DRAFT_KEY);
        const draft = baseline === null ? null : parseDraft(baseline);
        blocked = false;
        return { status: draft ? "restored" : "empty", draft };
      } catch (error) {
        blocked = true;
        return {
          status: baseline === undefined ? "unavailable" : "unreadable",
        };
      }
    },
    save(draft) {
      if (blocked) return { status: "blocked" };
      try {
        const storage = getStorage();
        if (storage.getItem(DRAFT_KEY) !== baseline) {
          blocked = true;
          return { status: "conflict" };
        }
        const raw = serializeDraft(draft);
        storage.setItem(DRAFT_KEY, raw);
        baseline = raw;
        return { status: "saved" };
      } catch {
        return { status: "unavailable" };
      }
    },
    replace(draft) {
      try {
        const raw = serializeDraft(draft);
        getStorage().setItem(DRAFT_KEY, raw);
        baseline = raw;
        blocked = false;
        return { status: "saved" };
      } catch {
        return { status: "unavailable" };
      }
    },
    raw() {
      return getStorage().getItem(DRAFT_KEY);
    },
    block() {
      blocked = true;
    },
  };
}
