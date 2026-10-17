import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { readFile } from "node:fs/promises";
import { DRAFT_KEY } from "./draft.mjs";

const accessible = async (page) => {
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(
    result.violations.map((v) => ({
      id: v.id,
      nodes: v.nodes.map((n) => n.target),
    })),
  ).toEqual([]);
};
const saved = (page) =>
  expect(page.locator("#save-status")).toHaveText("Saved on this browser");
test.beforeEach(async ({ page }) => {
  page.on("dialog", (dialog) => dialog.accept());
  await page.goto("/");
  await expect(page.locator("#startup-error")).toBeHidden();
});

test("editing, connecting and guards update observable outcomes without network actions", async ({
  page,
}) => {
  const requests = [],
    errors = [];
  page.on("request", (request) => requests.push(request.url()));
  page.on("pageerror", (error) => errors.push(error.message));
  await expect(page.locator("#creator-revenue")).toHaveText("1.20 SOL*");
  await page.getByRole("button", { name: "Add Treasury", exact: true }).click();
  await page.locator("#share-number").fill("35");
  await expect(page.locator("#creator-revenue")).toHaveText("0.78 SOL*");
  await page
    .getByRole("button", { name: "Add Safety controls", exact: true })
    .click();
  await expect(page.locator(".inspector h2")).toBeFocused();
  await page.locator("#limit-number").fill("0.9");
  await expect(page.locator("#buyer-outcome")).toHaveText("Blocked");
  await page
    .getByRole("button", { name: "Edit Graduation", exact: true })
    .click();
  await page.locator("#target-number").fill("20");
  await expect(page.getByRole("meter")).toHaveAttribute(
    "aria-valuenow",
    "100.0",
  );
  await page
    .getByRole("button", { name: "Edit Fee splitter", exact: true })
    .click();
  await page.locator("#module-action").click();
  await expect(
    page.getByRole("button", { name: "Add Treasury", exact: true }),
  ).toBeVisible();
  await expect(page.locator("#creator-revenue")).toHaveText("0.00 SOL*");
  await saved(page);
  expect(requests).toEqual([]);
  expect(errors).toEqual([]);
});

test("incomplete drafts restore and backup/import without falsely producing quotes", async ({
  page,
}) => {
  await page.locator("#expert").click();
  await page.locator("#reserve-number").fill("");
  await saved(page);
  await page.reload();
  await expect(page.locator("#expert")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#reserve-number")).toHaveValue("");
  await expect(page.locator("#reserve-number")).toHaveAttribute(
    "aria-invalid",
    "true",
  );
  await expect(page.locator("#spot-price")).toHaveText("—");
  await expect(page.locator("#export")).toBeDisabled();
  await accessible(page);
  const downloading = page.waitForEvent("download");
  await page.locator("#backup-draft").click();
  const file = await downloading;
  const raw = await readFile(await file.path(), "utf8");
  expect(JSON.parse(raw).state.values.reserve).toBeNull();
  await page.locator("#reserve-number").fill("73");
  await page.locator("#import").click();
  await page.locator("#import-json").fill(raw);
  await page.locator("#apply-import").click();
  await expect(page.locator("#cancel-change")).toBeFocused();
  await page.locator("#confirm-change").click();
  await expect(page.locator("#reserve-number")).toHaveValue("");
  await expect(page.locator("#spot-price")).toHaveText("—");
});

test("damaged drafts are recoverable and replacement requires confirmation", async ({
  page,
}) => {
  await page.evaluate(
    (key) => localStorage.setItem(key, "{damaged"),
    DRAFT_KEY,
  );
  await page.reload();
  await expect(page.locator("#storage-warning")).toContainText(
    "has not been overwritten",
  );
  await page.locator("#reserve-number").fill("73");
  expect(
    await page.evaluate((key) => localStorage.getItem(key), DRAFT_KEY),
  ).toBe("{damaged");
  await accessible(page);
  const downloading = page.waitForEvent("download");
  await page.locator("#recover-raw").click();
  expect(await readFile(await (await downloading).path(), "utf8")).toBe(
    "{damaged",
  );
  await page.locator("#replace-draft").click();
  await expect(page.locator("#cancel-change")).toBeFocused();
  await accessible(page);
  await page.locator("#cancel-change").click();
  expect(
    await page.evaluate((key) => localStorage.getItem(key), DRAFT_KEY),
  ).toBe("{damaged");
  await page.locator("#replace-draft").click();
  await page.locator("#confirm-change").click();
  await saved(page);
  await page.reload();
  await expect(page.locator("#reserve-number")).toHaveValue("73");
});

test("two tabs cannot silently overwrite each other, including simultaneous queued edits", async ({
  page,
  context,
}) => {
  const other = await context.newPage();
  other.on("dialog", (dialog) => dialog.accept());
  await other.goto("/");
  await expect(other.locator("#startup-error")).toBeHidden();
  // Hold the same browser lock to force both edited snapshots to queue together.
  await page.evaluate((key) => {
    navigator.locks.request(
      key,
      () =>
        new Promise((resolve) => {
          window.releaseSave = resolve;
        }),
    );
  }, DRAFT_KEY);
  await page.waitForFunction(() => !!window.releaseSave);
  await Promise.all([
    page.locator("#reserve-number").fill("73"),
    other.locator("#reserve-number").fill("41"),
  ]);
  await page.evaluate(() => window.releaseSave());
  await expect
    .poll(async () =>
      [
        await page.locator("#save-status").textContent(),
        await other.locator("#save-status").textContent(),
      ].sort(),
    )
    .toEqual(["Not saved · recovery needed", "Saved on this browser"]);
  const conflict = (await page.locator("#storage-warning").isVisible())
    ? page
    : other;
  const winner = conflict === page ? "41" : "73";
  await conflict.locator("#reload-draft").click();
  await conflict.locator("#confirm-change").click();
  await expect(conflict.locator("#reserve-number")).toHaveValue(winner);
  await expect(conflict.locator("#storage-warning")).toBeHidden();
});

test("storage denial and missing locks leave editing usable with an honest backup warning", async ({
  page,
}) => {
  for (const failure of ["denied", "quota", "locks"]) {
    await page.goto("/");
    await page.evaluate((failure) => {
      if (failure === "locks")
        Object.defineProperty(navigator, "locks", { value: undefined });
      else
        Storage.prototype[failure === "denied" ? "getItem" : "setItem"] =
          () => {
            throw new DOMException("unavailable", "SecurityError");
          };
    }, failure);
    await page
      .locator("#reserve-number")
      .fill(failure === "quota" ? "41" : "73");
    await expect(page.locator("#storage-warning")).toContainText(
      "may be lost on reload",
    );
    await expect(page.locator("#backup-draft")).toBeEnabled();
    await expect(page.locator("#spot-price")).not.toHaveText("—");
  }
});

test("keyboard dialogs, import errors, empty states and narrow screens remain accessible", async ({
  page,
  isMobile,
}) => {
  await accessible(page);
  await page.locator("#clear").click();
  await expect(page.locator("#cancel-change")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.locator("#confirm-change")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator("#clear")).toBeFocused();
  await page.locator("#clear").click();
  await page.locator("#confirm-change").click();
  await expect(page.locator("#canvas")).toContainText(
    "Every launch starts somewhere",
  );
  await page
    .getByRole("button", { name: "Add Governance", exact: true })
    .click();
  await expect(page.locator("#module-action")).toBeDisabled();
  await accessible(page);
  await page.locator("#import").click();
  await page
    .locator("#import-json")
    .fill('{"format":"hook-lab/1","bytecode":"anything"}');
  await page.locator("#apply-import").click();
  await expect(page.locator("#import-json")).toHaveAttribute(
    "aria-invalid",
    "true",
  );
  await expect(page.locator("#dialog")).toBeVisible();
  await accessible(page);
  await page.keyboard.press("Escape");
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
  if (isMobile) {
    await page.setViewportSize({ width: 390, height: 844 });
    await page
      .getByRole("button", { name: "Add Bonding curve", exact: true })
      .tap();
    await expect(page.locator(".inspector h2")).toBeInViewport();
    await expect(page.locator(".inspector h2")).toBeFocused();
    expect(
      await page
        .locator("#reserve-number")
        .evaluate((el) => getComputedStyle(el).fontSize),
    ).toBe("16px");
  }
});

test("separate metadata review never converts modules, overwrites storage or exports stale inputs", async ({ page }) => {
  const requests = [], errors = [];
  page.on("request", request => requests.push(request.url()));
  page.on("pageerror", error => errors.push(error.message));
  await page.locator("#expert").click();
  for (const name of ["Treasury", "Governance", "Safety controls"])
    await page.getByRole("button", { name: `Add ${name}`, exact: true }).click();
  await saved(page);
  const original = await page.evaluate(key => localStorage.getItem(key), DRAFT_KEY);
  const open = async () => {
    await page.locator("#boundary").click();
    await page.locator("#plain-draft").click();
  };
  await open();
  await expect(page.locator("#plain-name")).toHaveValue("");
  await expect(page.locator("#plain-ticker")).toHaveValue("");
  await expect(page.locator("#plain-preview")).toBeHidden();
  await accessible(page);
  await page.getByRole("button", { name: "Review metadata" }).click();
  await expect(page.locator("#plain-name")).toBeFocused();
  await expect(page.locator("#plain-name")).toHaveAttribute("aria-invalid", "true");
  await accessible(page);
  await page.locator("#plain-name").fill("  Café builders  ");
  await page.locator("#plain-ticker").fill("build9");
  await page.getByRole("button", { name: "Review metadata" }).click();
  await expect(page.locator("#plain-ack")).toBeFocused();
  await page.locator("#plain-ack").check();
  await page.getByRole("button", { name: "Review metadata" }).click();
  await expect(page.locator("#plain-review-title")).toBeFocused();
  await accessible(page);
  const expected = {
    schemaVersion: "repo-ing/hook-lab-recipe/1", template: "plain",
    recipe: { format: "hook-lab/1", coin: { name: "Café builders", ticker: "BUILD9" }, blocks: [] },
  };
  expect(JSON.parse(await page.locator("#plain-json").inputValue())).toEqual(expected);
  const download = page.waitForEvent("download");
  await page.locator("#download-plain").click();
  const file = await download;
  expect(file.suggestedFilename()).toBe("hook-plain-metadata-draft.json");
  const raw = await readFile(await file.path(), "utf8");
  expect(JSON.parse(raw)).toEqual(expected);
  await page.locator("#plain-ticker").fill("CHANGED");
  await expect(page.locator("#plain-preview")).toBeHidden();
  await page.keyboard.press("Escape");
  await expect(page.locator("#boundary")).toBeFocused();
  expect(await page.evaluate(key => localStorage.getItem(key), DRAFT_KEY)).toBe(original);
  await open();
  await expect(page.locator("#plain-name")).toHaveValue("");
  await expect(page.locator("#plain-ack")).not.toBeChecked();
  await page.locator("#cancel-change").click();
  await page.locator("#import").click();
  await page.locator("#import-json").fill(raw);
  await page.locator("#apply-import").click();
  await expect(page.locator("#import-json")).toHaveAttribute("aria-invalid", "true");
  expect(await page.evaluate(key => localStorage.getItem(key), DRAFT_KEY)).toBe(original);
  expect(requests).toEqual([]);
  expect(errors).toEqual([]);
});
