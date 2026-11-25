import { expect, test, type Page } from "@playwright/test";

/**
 * Spec §14 Phase 2 flows on the iPhone 15 viewport against freshly seeded demo data:
 * assign, move, auto-assign underfunded, split, reconcile. Each flow checks the number it changed.
 */
test.describe.configure({ mode: "serial" });
test.skip(({ isMobile }) => !isMobile, "Phase 2 flows run on the iPhone project");

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("hb_install_hint_dismissed", "1"));
});

/** Ready to Assign in milliunits, read from the banner's exact data-value. */
async function rta(page: Page): Promise<bigint> {
  const v = await page.getByRole("region", { name: "Ready to Assign" }).locator("[data-value]").first().getAttribute("data-value");
  return BigInt(v!);
}
async function waitForRta(page: Page, expected: bigint) {
  await expect.poll(() => rta(page), { timeout: 15_000 }).toBe(expected);
}
/** On phones Assigned is edited in the category sheet (YNAB iOS). Reads it there, then closes the sheet. */
async function assignedOf(page: Page, name: string): Promise<string> {
  await page.getByRole("button", { name: `${name} details` }).click();
  const label = (await page.getByRole("dialog").getByRole("button", { name: new RegExp(`^Assigned to ${name}: `) }).getAttribute("aria-label"))!;
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();
  return label;
}

test("assign with +50, then undo", async ({ page }) => {
  await page.goto("/plan");
  const before = await rta(page);
  await page.getByRole("button", { name: "Groceries details" }).click();
  const sheet = page.getByRole("dialog");
  await sheet.getByRole("button", { name: /^Assigned to Groceries: / }).click();
  const input = sheet.getByLabel("Assigned to Groceries");
  await input.fill("+50");
  await input.press("Enter");
  await waitForRta(page, before - 50_000n);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Undo" }).click();
  await waitForRta(page, before);
  // the server agrees after a reload
  await page.reload();
  await waitForRta(page, before);
});

test("move money between categories keeps Ready to Assign", async ({ page }) => {
  await page.goto("/plan");
  const before = await rta(page);
  const groceriesBefore = await assignedOf(page, "Groceries");
  await page.getByRole("button", { name: "Groceries details" }).click();
  const sheet = page.getByRole("dialog");
  await sheet.getByRole("button", { name: "Move money" }).click();
  const amt = sheet.getByLabel("Amount to move");
  await amt.fill("10");
  await amt.press("Enter");
  await sheet.getByRole("option", { name: /Dates/ }).first().click();
  await expect(page.getByText(/Moved \$10\.00 from Groceries to Dates/)).toBeVisible();
  await page.keyboard.press("Escape");
  await page.reload();
  expect(await rta(page)).toBe(before);
  expect(await assignedOf(page, "Groceries")).not.toBe(groceriesBefore);
});

test("auto-assign underfunded", async ({ page }) => {
  await page.goto("/plan");
  const before = await rta(page);
  await page.getByRole("button", { name: "Assign", exact: true }).click();
  await page.getByRole("menuitem", { name: /Underfunded/ }).click();
  await expect(page.getByText(/Auto-Assign \(Underfunded\)/)).toBeVisible();
  await page.reload();
  const after = await rta(page);
  expect(after).toBeLessThanOrEqual(before);
  await expect(page.getByRole("radio", { name: /Underfunded/ })).toContainText("0");
});

test("split a transaction from the review inbox", async ({ page }) => {
  await page.goto("/activity");
  await page.getByRole("button", { name: "View transactions to approve" }).click();
  const card = page.getByRole("region", { name: /Approve and categorize/ }).locator("text=Amazon").first();
  await expect(card).toBeVisible();
  await page.getByRole("button", { name: /More actions for Amazon/ }).first().click();
  await page.getByRole("menuitem", { name: "Split" }).click();
  const sheet = page.getByRole("dialog");
  await sheet.getByRole("button", { name: "Split", exact: true }).click();
  const line1 = sheet.getByLabel("Amount for line 1");
  const total = Number((await line1.inputValue()).replace(/,/g, ""));
  await line1.fill((total - 10).toFixed(2));
  await line1.press("Enter");
  const line2 = sheet.getByLabel("Amount for line 2");
  await line2.fill("10");
  await line2.press("Enter");
  await expect(sheet.getByText("Fully split")).toBeVisible();
  for (const [line, cat] of [
    [1, "Groceries"],
    [2, "Gifts"],
  ] as const) {
    await sheet.getByRole("button", { name: new RegExp(`(Choose category for line ${line}|^${cat}$|^Misc$)`) }).first().click();
    await sheet.getByRole("option", { name: new RegExp(cat) }).first().click();
  }
  await sheet.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(/^Saved Amazon/)).toBeVisible();
  await page.reload();
  await expect(page.getByRole("listitem").filter({ hasText: "Amazon" }).filter({ hasText: "Split · 2 categories" }).first()).toBeVisible();
});

test("reconcile checking with an adjustment", async ({ page }) => {
  await page.goto("/activity");
  await page.locator('a[href^="/activity/"]').filter({ has: page.locator("span", { hasText: /^Checking$/ }) }).filter({ visible: true }).first().click();
  await page.waitForURL(/\/activity\/[0-9a-f-]{36}/);
  await page.getByRole("button", { name: "Reconcile", exact: true }).click();
  const sheet = page.getByRole("dialog");
  await sheet.getByRole("button", { name: "No" }).click();
  const input = sheet.getByLabel("Statement (cleared) balance");
  await input.fill("+1");
  await input.press("Enter");
  await expect(sheet.getByText("+$1.00").first()).toBeVisible();
  await sheet.getByRole("button", { name: "Add adjustment and reconcile" }).click();
  await expect(page.getByText(/reconciled with a \+\$1\.00 adjustment/)).toBeVisible();
  await page.reload();
  await expect(page.getByText("Reconciliation Balance Adjustment").filter({ visible: true }).first()).toBeVisible();
  await expect(page.getByText(/Last reconciled/)).toBeVisible();
});
