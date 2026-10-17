import test from "node:test";
import assert from "node:assert/strict";
import {
  initialState,
  simulate,
  disconnect,
  validate,
  exportScenario,
  importScenario,
} from "./model.mjs";

test("constant-product price, asymmetric routing and buyer round-trip loss use independent expectations", () => {
  const s = initialState();
  s.connected.push("treasury");
  s.values.demand = 1;
  s.values.share = 35;
  const r = simulate(s);
  assert.equal(r.startPrice, 30 / 1e9);
  assert.ok(Math.abs(r.price - 30.97 ** 2 / 30e9) < 1e-18);
  assert.ok(Math.abs(r.creator - 0.013) < 1e-12);
  assert.ok(Math.abs(r.treasury - 0.007) < 1e-12);
  assert.ok(Math.abs(r.buyerExit - 0.9409) < 1e-12);
  assert.equal(r.locked, r.treasury);
  s.values.lock = 0;
  assert.equal(simulate(s).locked, 0);
});
test("graduation caps modeled volume and fee revenue; disconnect removes the cap", () => {
  const s = initialState();
  s.values.demand = 250;
  s.values.target = 20;
  const r = simulate(s);
  assert.equal(r.graduated, true);
  assert.equal(r.progress, 100);
  assert.ok(Math.abs(r.gross - 20 / 0.97) < 1e-12);
  assert.ok(Math.abs(r.creator - (20 / 0.97) * 0.02) < 1e-12);
  assert.ok(Math.abs(r.price - 50 ** 2 / 30e9) < 1e-18);
  disconnect(s, "graduation");
  assert.equal(simulate(s).gross, 250);
  assert.equal(simulate(s).target, Infinity);
});
test("dependencies disconnect transitively without discarding settings", () => {
  const s = initialState();
  s.connected.push("treasury", "governance", "safety");
  s.values.share = 55;
  disconnect(s, "fees");
  assert.deepEqual(s.connected, ["curve", "graduation", "safety"]);
  assert.equal(s.values.share, 55);
  assert.equal(simulate(s).creator, 0);
  disconnect(s, "curve");
  assert.equal(simulate(s).empty, true);
});
test("safety boundary and governance change risk, not fabricated market prices", () => {
  const s = initialState();
  s.connected.push("treasury", "governance", "safety");
  s.values.buyer = 2;
  assert.equal(simulate(s).buyerBlocked, false);
  s.values.buyer = 2.1;
  assert.equal(simulate(s).buyerBlocked, true);
  const price = simulate(s).price;
  s.values.delay = 0;
  const r = simulate(s);
  assert.equal(r.price, price);
  assert.ok(r.risks.some((x) => x.includes("admin delay")));
});
test("invalid inputs suspend results; import is strict and lossless", () => {
  const s = initialState();
  assert.deepEqual(importScenario(exportScenario(s)), s);
  for (const invalid of [null, -1, 101, NaN, Infinity, "30"]) {
    const bad = initialState();
    bad.values.reserve = invalid;
    assert.ok(validate(bad).length);
    assert.equal(simulate(bad).price, undefined);
  }
  s.values.buyer = 10;
  s.values.demand = 1;
  assert.ok(validate(s).length);
  for (const raw of [
    "{",
    '{"format":"hook-lab/1"}',
    JSON.stringify({
      ...JSON.parse(exportScenario(initialState())),
      connected: ["treasury"],
    }),
    JSON.stringify({
      ...JSON.parse(exportScenario(initialState())),
      bytecode: "x",
    }),
  ])
    assert.throws(() => importScenario(raw));
});
