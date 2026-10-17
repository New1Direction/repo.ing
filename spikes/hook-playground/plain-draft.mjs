// Metadata authoring only. This module accepts no scenario, recipe import,
// network, economics or execution settings. Keep the simulator dependency-free.
// Wire contract: src/hook-lab-templates.mjs + src/hook-lab-recipe.mjs.
export function createPlainDraft(metadata) {
  if (
    !metadata ||
    Object.getPrototypeOf(metadata) !== Object.prototype ||
    Reflect.ownKeys(metadata).length !== 2 ||
    !Object.hasOwn(metadata, "name") ||
    !Object.hasOwn(metadata, "ticker")
  )
    throw new Error("Only a new name and ticker are accepted. No simulation settings or rules can be carried over.");
  if (
    typeof metadata.name !== "string" ||
    !metadata.name.trim() ||
    new TextEncoder().encode(metadata.name.trim()).length > 32
  )
    throw Object.assign(new Error("Enter a name using 1–32 UTF-8 bytes."), { field: "name" });
  if (
    typeof metadata.ticker !== "string" ||
    !/^[A-Za-z0-9]{1,10}$/.test(metadata.ticker)
  )
    throw Object.assign(new Error("Use 1–10 ASCII letters or digits, without spaces."), { field: "ticker" });
  return {
    schemaVersion: "repo-ing/hook-lab-recipe/1",
    template: "plain",
    recipe: {
      format: "hook-lab/1",
      coin: { name: metadata.name.trim(), ticker: metadata.ticker.toUpperCase() },
      blocks: [],
    },
  };
}
