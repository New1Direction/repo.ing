// Deliberately hypothetical economics. No SDK, RPC, wallet, or production imports.
export const modules = {
  curve: {
    title: "Bonding curve",
    icon: "curve",
    description: "How demand moves the price.",
    kind: "Model",
    parent: null,
  },
  fees: {
    title: "Fee splitter",
    icon: "split",
    description: "Where trading fees go.",
    kind: "Concept",
    parent: "curve",
  },
  treasury: {
    title: "Treasury",
    icon: "bank",
    description: "Reserve a share for the project.",
    kind: "Concept",
    parent: "fees",
  },
  graduation: {
    title: "Graduation",
    icon: "flag",
    description: "Where the curve journey ends.",
    kind: "Model",
    parent: "curve",
  },
  governance: {
    title: "Governance",
    icon: "users",
    description: "Explore delayed administration.",
    kind: "Concept",
    parent: "treasury",
  },
  safety: {
    title: "Safety controls",
    icon: "shield",
    description: "Test a per-purchase limit.",
    kind: "Concept",
    parent: "curve",
  },
};
export const fields = {
  reserve: {
    module: "curve",
    label: "Virtual quote reserve",
    unit: "SOL*",
    min: 5,
    max: 100,
    step: 1,
    hint: "A higher reserve flattens price impact. Virtual reserves are not deposited funds.",
  },
  fee: {
    module: "fees",
    label: "Trading fee",
    unit: "%",
    min: 0,
    max: 15,
    step: 0.5,
    hint: "An illustrative fee on buys and sells, on top of the 1% model protocol fee.",
  },
  share: {
    module: "treasury",
    label: "Treasury share of fees",
    unit: "%",
    min: 0,
    max: 100,
    step: 5,
    hint: "The creator receives the remainder. This is hypothetical routing, not a supported recipient configuration.",
  },
  lock: {
    module: "treasury",
    label: "Treasury lock",
    unit: "days",
    min: 0,
    max: 365,
    step: 1,
    hint: "Locked funds still count toward treasury revenue; this does not lock liquidity.",
  },
  target: {
    module: "graduation",
    label: "Net quote target",
    unit: "SOL*",
    min: 20,
    max: 200,
    step: 5,
    hint: "The model stops here. No migration, pool liquidity, or post-graduation trading is simulated.",
  },
  delay: {
    module: "governance",
    label: "Admin delay",
    unit: "hours",
    min: 0,
    max: 168,
    step: 1,
    hint: "Only changes the qualitative control assessment. No governance contract is deployed.",
  },
  limit: {
    module: "safety",
    label: "Maximum single buy",
    unit: "SOL*",
    min: 0.1,
    max: 10,
    step: 0.1,
    hint: "A purchase-size guard, not a per-wallet or per-person limit. Repeated buys can bypass it.",
  },
  demand: {
    label: "Cumulative buy demand",
    unit: "SOL*",
    min: 1,
    max: 250,
    step: 1,
  },
  buyer: {
    label: "First buyer spends",
    unit: "SOL*",
    min: 0.1,
    max: 10,
    step: 0.1,
  },
};
export function initialState() {
  return {
    connected: ["curve", "fees", "graduation"],
    values: {
      reserve: 30,
      fee: 2,
      share: 30,
      lock: 30,
      target: 85,
      delay: 48,
      limit: 2,
      demand: 60,
      buyer: 1,
    },
  };
}
// Editing drafts preserve blanks and out-of-range numbers; runnable scenarios do not.
export function validateDraft(state) {
  if (
    !state ||
    typeof state !== "object" ||
    Object.keys(state).some((key) => !["connected", "values"].includes(key)) ||
    !Array.isArray(state.connected) ||
    !state.values ||
    typeof state.values !== "object" ||
    Array.isArray(state.values) ||
    Object.keys(state.values).length !== Object.keys(fields).length ||
    Object.keys(state.values).some((key) => !Object.hasOwn(fields, key))
  )
    return ["This is not a Playground scenario."];
  if (
    state.connected.some(
      (id) => typeof id !== "string" || !Object.hasOwn(modules, id),
    ) ||
    new Set(state.connected).size !== state.connected.length
  )
    return ["Unknown or duplicate modules are not supported."];
  if (
    Object.values(state.values).some(
      (value) =>
        value !== null &&
        (typeof value !== "number" || !Number.isFinite(value)),
    )
  )
    return ["Draft values must be finite numbers or blank fields."];
  const errors = [];
  for (const id of state.connected) {
    if (modules[id].parent && !state.connected.includes(modules[id].parent))
      errors.push(
        `${modules[id].title} needs ${modules[modules[id].parent].title}.`,
      );
  }
  return errors;
}
export function validate(state) {
  const errors = validateDraft(state);
  if (errors.length) return errors;
  for (const [key, field] of Object.entries(fields)) {
    const value = state.values[key];
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      value < field.min ||
      value > field.max
    )
      errors.push(
        `${field.label} must be between ${field.min} and ${field.max} ${field.unit}.`,
      );
  }
  if (state.values.buyer > state.values.demand)
    errors.push("Cumulative demand must include the first buyer’s purchase.");
  return errors;
}
export function disconnect(state, id) {
  const removed = new Set([id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const key of state.connected)
      if (!removed.has(key) && removed.has(modules[key].parent)) {
        removed.add(key);
        changed = true;
      }
  }
  state.connected = state.connected.filter((key) => !removed.has(key));
}
export function simulate(state) {
  const errors = validate(state);
  if (errors.length) return { errors };
  const has = (id) => state.connected.includes(id),
    v = state.values;
  if (!has("curve")) return { errors: [], empty: true };
  const fee = has("fees") ? v.fee / 100 : 0,
    retained = 1 - fee - 0.01;
  const target = has("graduation") ? v.target : Infinity;
  const gross = Math.min(v.demand, target / retained),
    net = gross * retained;
  const supply = 1e9,
    tokensLeft = (supply * v.reserve) / (v.reserve + net);
  const startPrice = v.reserve / supply,
    price = (v.reserve + net) / tokensLeft;
  const buyerNet = v.buyer * retained,
    buyerTokens = (supply * buyerNet) / (v.reserve + buyerNet);
  const exitGross =
    ((v.reserve + net) * buyerTokens) / (tokensLeft + buyerTokens);
  const buyerBlocked = has("safety") && v.buyer > v.limit;
  const feeTotal = gross * fee,
    treasury = has("treasury") ? (feeTotal * v.share) / 100 : 0;
  const risks = [];
  if (price / startPrice > 4)
    risks.push(
      "Price moves more than 4×; later buyers face large price impact.",
    );
  if (fee >= 0.05)
    risks.push(
      "High trading fees reduce buyer returns on both entry and exit.",
    );
  if (!has("safety")) risks.push("No single-purchase guard is connected.");
  if (!has("governance") || v.delay < 24)
    risks.push("No modeled admin delay of at least 24 hours.");
  if (has("treasury") && v.lock === 0)
    risks.push("Treasury revenue is immediately accessible.");
  if (!has("graduation"))
    risks.push("No graduation target; the curve has no modeled endpoint.");
  return {
    errors: [],
    gross,
    net,
    startPrice,
    price,
    buyerTokens,
    buyerBlocked,
    buyerExit: exitGross * retained,
    creator: feeTotal - treasury,
    treasury,
    locked: has("treasury") && v.lock > 0 ? treasury : 0,
    feeTotal,
    target,
    progress: Number.isFinite(target) ? Math.min(100, (net / target) * 100) : 0,
    graduated: net >= target - 1e-9,
    risks,
    risk: risks.length >= 3 ? "Elevated" : "Moderate",
    points: Array.from({ length: 41 }, (_, i) => {
      const q = (net * i) / 40;
      return {
        x: (gross * i) / 40,
        y: (v.reserve + q) ** 2 / (supply * v.reserve),
      };
    }),
  };
}
export function exportScenario(state) {
  if (validate(state).length)
    throw new Error("Resolve validation errors before exporting.");
  return JSON.stringify(
    { format: "repoing-playground/1", simulationOnly: true, ...state },
    null,
    2,
  );
}
export function importScenario(text) {
  if (typeof text !== "string" || text.length > 32768)
    throw new Error(
      "Scenario is too large. Use a Playground JSON file under 32 KB.",
    );
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(
      "Could not read JSON. Check commas and quotes, then try again. Your current scenario is unchanged.",
    );
  }
  if (data?.format !== "repoing-playground/1" || data?.simulationOnly !== true)
    throw new Error(
      "Only repoing-playground/1 files are supported. Hook recipes, custom hooks, and transaction data cannot be imported.",
    );
  if (
    Object.keys(data).some(
      (k) => !["format", "simulationOnly", "connected", "values"].includes(k),
    ) ||
    Object.keys(data.values ?? {}).some((k) => !Object.hasOwn(fields, k))
  )
    throw new Error("Unsupported custom fields found. Nothing was imported.");
  const state = { connected: data.connected, values: data.values },
    errors = validate(state);
  if (errors.length) throw new Error(errors.join(" "));
  return state;
}
