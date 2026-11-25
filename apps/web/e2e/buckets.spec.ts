import { mkdirSync, writeFileSync } from "node:fs";
import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * The simple bucket budget (ADR "Web: simple bucket budget (glow)") on freshly seeded demo data:
 * bar widths for under / over budget, the fill animation, the keyboard categorize flow (Enter, typing a
 * bucket name, multi-select, undo), the shortcut sheet, inline goals, phone gestures and the account chart.
 */
test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("hb_install_hint_dismissed", "1"));
});

const money = (s: string) => Number(s.replace(/[$,]/g, ""));

/** Rendered share of the track that a bar part covers. */
async function share(row: Locator, part: "fill" | "over"): Promise<number> {
  return row.evaluate((el, p) => {
    const track = el.querySelector<HTMLElement>(".hb-bar")!;
    const fill = el.querySelector<HTMLElement>(`[data-part="${p}"]`);
    if (!fill) return 0;
    return fill.getBoundingClientRect().width / track.getBoundingClientRect().width;
  }, part);
}

async function waitSettled(page: Page) {
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(2600);
}

test("budget bars: under budget shows what's left, over budget fills red", async ({ page }) => {
  await page.goto("/budget");
  await expect(page.getByRole("heading", { name: "Budget", level: 1 })).toBeVisible();
  await waitSettled(page);
  // no YNAB concepts in the main UI
  await expect(page.getByText(/Ready to Assign/i)).toHaveCount(0);
  await expect(page.locator('[data-category-id]').filter({ hasText: /^(Cash Back Card|Rewards Card)/ })).toHaveCount(0);

  // the first bucket with a good share left (earlier flows on this run may have changed Groceries)
  const unders = page.locator('[data-category-id][data-bar-state="under"]');
  const fills = await unders.evaluateAll((els) => els.map((e) => Number(e.querySelector<HTMLElement>(".hb-bar")?.dataset.fill ?? 0)));
  const under = unders.nth(Math.max(0, fills.findIndex((f) => f > 0.1 && f < 0.95)));
  const label = (await under.getByRole("img").getAttribute("aria-label"))!;
  const [, left, of] = /: (\$[\d,.]+) left of (\$[\d,.]+)/.exec(label)!;
  const expected = money(left!) / money(of!);
  expect(expected).toBeGreaterThan(0.05);
  expect(await share(under, "fill")).toBeCloseTo(expected, 1);

  const over = page.locator('[data-category-id][data-bar-state="over"]').first();
  await expect(over).toBeVisible();
  const ol = (await over.getByRole("img").getAttribute("aria-label"))!;
  const [, by, budget] = /: (\$[\d,.]+) over a (\$[\d,.]+) budget/.exec(ol)!;
  expect(await share(over, "over")).toBeCloseTo(Math.min(1, money(by!) / money(budget!)), 1);
  expect(await share(over, "fill")).toBeLessThan(0.02);
  await expect(over).toContainText("over");
});

test("budget bars fill in with an animation on month change", async ({ page }) => {
  await page.goto("/budget");
  await waitSettled(page);
  await page.getByRole("link", { name: /^Previous month/ }).filter({ visible: true }).first().click();
  const samples = await page.evaluate(async () => {
    const find = () => document.querySelector('[data-month="2026-09-01"]');
    const t0 = performance.now();
    while (!find() && performance.now() - t0 < 15_000) await new Promise((r) => requestAnimationFrame(r));
    const rows = [...find()!.querySelectorAll<HTMLElement>('[data-category-id][data-bar-state="under"]')];
    const best = rows.sort((a, b) => Number(b.querySelector<HTMLElement>(".hb-bar")!.dataset.fill) - Number(a.querySelector<HTMLElement>(".hb-bar")!.dataset.fill))[0]!;
    const track = best.querySelector<HTMLElement>(".hb-bar")!;
    const fill = best.querySelector<HTMLElement>('[data-part="fill"]')!;
    const w = () => fill.getBoundingClientRect().width / track.getBoundingClientRect().width;
    const at0 = w();
    await new Promise((r) => setTimeout(r, 1200));
    return { target: Number(track.dataset.fill), at0, at1200: w(), name: best.querySelector("span.truncate")?.textContent };
  });
  mkdirSync("test-results/screens/buckets", { recursive: true });
  writeFileSync(`test-results/screens/buckets/animation-${test.info().project.name}.json`, JSON.stringify(samples, null, 2));
  expect(samples.target).toBeGreaterThan(0.3);
  expect(samples.at0).toBeLessThan(samples.target * 0.35);
  expect(samples.at1200).toBeGreaterThan(samples.target * 0.9);
});

test("a bucket without a goal gets one inline", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop flow; the phone uses the bucket sheet");
  await page.goto("/budget");
  const row = page.locator('[data-category-id][data-bar-state="none"]').first();
  const name = (await row.locator("span.truncate").first().textContent())!;
  await row.getByRole("button", { name: `Set a goal for ${name}` }).click();
  const input = row.getByLabel(`Monthly goal for ${name}`);
  await input.fill("200");
  await input.press("Enter");
  await expect(page.getByText(`${name}: $200 a month`)).toBeVisible();
  await expect(page.locator(`[data-category-id][data-bar-state="under"]`).filter({ hasText: name })).toBeVisible({ timeout: 15_000 });
});

test("bucket sheet lists this month's transactions", async ({ page }) => {
  await page.goto("/budget");
  await page.getByRole("button", { name: "Groceries details" }).click();
  const sheet = page.getByRole("dialog", { name: /Groceries/ });
  await expect(sheet.getByRole("region", { name: "Goal" })).toBeVisible();
  await expect(sheet.getByRole("region", { name: "Transactions this month" }).locator("li").first()).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
});

test("overflow: turn on rollover, set what's already saved, then turn it off", async ({ page }) => {
  await page.goto("/budget");
  const name = "Alex's Spending Money";
  await page.getByRole("button", { name: `${name} details` }).click();
  const sheet = page.getByRole("dialog", { name: new RegExp(name) });
  const overflow = sheet.getByRole("region", { name: "Overflow" });
  const toggle = overflow.getByRole("switch", { name: /Roll leftover money into next month/ });
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await expect(sheet.getByTestId("rollover-note")).toHaveText(/leftovers roll over/);
  await overflow.getByRole("button", { name: /^Already saved in .*Edit$/ }).click();
  await overflow.getByLabel(`Already saved in ${name}`).fill("175");
  await page.keyboard.press("Enter");
  await expect(sheet.getByTestId("rollover-note")).toHaveText(/\+ \$175 rolled over/);
  await page.keyboard.press("Escape");
  const row = page.locator("[data-category-id]").filter({ has: page.getByRole("button", { name: `${name} details` }) });
  await expect(row.getByTestId("rollover-icon")).toBeVisible();
  await expect(row.getByTestId("rollover-note")).toHaveText(/\$100 goal \+ \$175 rolled over/);
  // back off, so the next project starts clean
  await page.getByRole("button", { name: `${name} details` }).click();
  await sheet.getByRole("switch", { name: /Roll leftover money/ }).click();
  await expect(sheet.getByRole("switch", { name: /Roll leftover money/ })).toHaveAttribute("aria-checked", "false");
  await page.keyboard.press("Escape");
  await expect(row.getByTestId("rollover-icon")).toHaveCount(0);
});

const reviewRows = (page: Page) => page.locator('[role="listbox"][aria-label="Transactions"] > li[data-tx-id]');

test("keyboard: Enter accepts the suggestion and the next row takes focus; u undoes", async ({ page, isMobile }) => {
  test.skip(isMobile, "keyboard flow");
  await page.goto("/transactions");
  const rows = reviewRows(page);
  await expect(rows.first()).toBeVisible();
  const before = await rows.count();
  const target = rows.filter({ has: page.locator('[data-chip="suggestion"]') }).first();
  const id = (await target.getAttribute("data-tx-id"))!;
  const next = rows.nth((await rows.evaluateAll((els, i) => els.findIndex((e) => e.getAttribute("data-tx-id") === i), id)) + 1);
  const nextId = await next.getAttribute("data-tx-id");
  await target.locator("span.truncate").first().click();
  await expect(target).toHaveAttribute("data-focused", "true");
  await page.keyboard.press("Enter");
  await expect(page.locator(`[data-tx-id="${id}"]`)).toHaveCount(0);
  await expect(rows).toHaveCount(before - 1);
  if (nextId) await expect(page.locator(`[data-tx-id="${nextId}"]`)).toHaveAttribute("data-focused", "true");
  await expect(page.getByRole("status").filter({ hasText: "→" }).first()).toBeVisible();
  // the server agrees
  await page.reload();
  await expect(rows.first()).toBeVisible();
  await expect(page.locator(`[data-tx-id="${id}"]`)).toHaveCount(0);
  await expect(page.getByTestId("review-badge")).toHaveText(String(before - 1));
});

test("keyboard: type a bucket name and Enter", async ({ page, isMobile }) => {
  test.skip(isMobile, "keyboard flow");
  await page.goto("/transactions");
  const rows = reviewRows(page);
  await expect(rows.first()).toBeVisible();
  const row = rows.first();
  const id = (await row.getAttribute("data-tx-id"))!;
  await expect(row).toHaveAttribute("data-focused", "true");
  await page.keyboard.press("g");
  const picker = page.getByRole("dialog", { name: /Choose a bucket/ });
  await expect(picker).toBeVisible();
  await page.keyboard.type("roc");
  await expect(picker.getByRole("option").first()).toContainText("Groceries");
  await page.keyboard.press("Enter");
  await expect(page.locator(`[data-tx-id="${id}"]`)).toHaveCount(0);
  // undo brings it back
  await page.keyboard.press("u");
  await expect(page.locator(`[data-tx-id="${id}"]`)).toHaveCount(1);
  await expect(page.getByText(/^Undid /)).toBeVisible();
  // and again, for real
  await page.locator(`[data-tx-id="${id}"] span.truncate`).first().click();
  await page.keyboard.press("g");
  await page.keyboard.type("roc");
  await page.keyboard.press("Enter");
  await expect(page.locator(`[data-tx-id="${id}"]`)).toHaveCount(0);
  await page.goto("/transactions?view=all");
  await expect(page.locator(`[data-tx-id="${id}"]`)).toContainText("Groceries");
});

test("multi-select with Shift+↓, then one bucket for all of them", async ({ page, isMobile }) => {
  test.skip(isMobile, "keyboard flow");
  await page.goto("/transactions");
  const rows = reviewRows(page);
  await expect(rows.first()).toBeVisible();
  await expect(rows.first()).toHaveAttribute("data-focused", "true");
  const before = await rows.count();
  expect(before).toBeGreaterThanOrEqual(3);
  const ids = await rows.evaluateAll((els) => els.slice(0, 3).map((e) => e.getAttribute("data-tx-id")!));
  await page.keyboard.press("Shift+ArrowDown");
  await page.keyboard.press("Shift+ArrowDown");
  await expect(page.locator('li[data-tx-id][aria-selected="true"]')).toHaveCount(3);
  await expect(page.getByText("3 selected")).toBeVisible();
  await page.keyboard.press("d");
  const picker = page.getByRole("dialog", { name: "Choose a bucket for 3 transactions" });
  await expect(picker).toBeVisible();
  await page.keyboard.type("ates");
  await page.keyboard.press("Enter");
  for (const id of ids) await expect(page.locator(`[data-tx-id="${id}"]`)).toHaveCount(0);
  await page.reload();
  await expect(rows).toHaveCount(before - 3);
});

test("correcting the same payee twice teaches a rule (learned toast)", async ({ page, isMobile }) => {
  test.skip(isMobile, "keyboard flow");
  await page.goto("/transactions");
  const rows = reviewRows(page).filter({ hasText: "Amazon" });
  await expect(reviewRows(page).first()).toHaveAttribute("data-focused", "true");
  test.skip((await rows.count()) < 2, "needs two Amazon rows waiting for review");
  for (let n = 0; n < 2; n++) {
    const row = rows.first();
    const id = (await row.getAttribute("data-tx-id"))!;
    await row.locator("span.truncate").first().click();
    await page.keyboard.press("Shift+G");
    await page.keyboard.type("ifts");
    await page.keyboard.press("Enter");
    await expect(page.locator(`[data-tx-id="${id}"]`)).toHaveCount(0);
  }
  await expect(page.getByText("Learned: Amazon → Gifts")).toBeVisible({ timeout: 15_000 });
});

test("? opens the shortcut cheat sheet", async ({ page, isMobile }) => {
  test.skip(isMobile, "keyboard");
  await page.goto("/transactions");
  // hydrated: the first row takes keyboard focus
  await expect(reviewRows(page).first()).toHaveAttribute("data-focused", "true");
  await page.keyboard.press("?");
  const sheet = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText("Accept the suggestion and approve");
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
});

test("phone: tab bar; tapping a suggestion opens the picker, the tick accepts it", async ({ page, isMobile }) => {
  test.skip(!isMobile, "phone");
  await page.goto("/budget");
  const nav = page.getByRole("navigation", { name: "Primary" }).filter({ visible: true });
  for (const t of ["Budget", "Transactions", "Accounts"]) await expect(nav.getByRole("link", { name: new RegExp(t) })).toBeVisible();
  await nav.getByRole("link", { name: /Transactions/ }).click();
  await expect(page).toHaveURL(/\/transactions$/);
  const chip = page.locator('[data-chip="suggestion"]').first();
  if (await chip.count()) {
    const row = page.locator("li[data-tx-id]").filter({ has: chip }).first();
    const id = (await row.getAttribute("data-tx-id"))!;
    await chip.click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("combobox", { name: "Search buckets" })).toBeVisible();
    await expect(dialog.getByText("Suggested").first()).toBeVisible();
    await page.keyboard.press("Escape");
    await row.getByRole("button", { name: /^Accept / }).click();
    await expect(page.locator(`[data-tx-id="${id}"]`)).toHaveCount(0);
    // put it back (the Phase 2 plan flows that run next on this project expect the seeded budget)
    await page.getByRole("button", { name: "Undo" }).click();
    await expect(page.locator(`[data-tx-id="${id}"]`)).toHaveCount(1);
    await expect(page.getByText(/^Undid /)).toBeVisible();
  }
  // the category area opens the bottom-sheet picker
  const cat = page.locator('[data-chip="category"]').first();
  await cat.click();
  await expect(page.getByRole("dialog").getByRole("combobox", { name: "Search buckets" })).toBeVisible();
});

test("account page: balance chart with ranges and scrubbing, then its transactions", async ({ page, isMobile }) => {
  if (isMobile) {
    await page.goto("/accounts");
    await page.locator("a[data-account-id]").filter({ has: page.locator("span", { hasText: /^Checking$/ }) }).filter({ visible: true }).first().click();
  } else {
    await page.goto("/budget");
    await page.getByRole("complementary", { name: "Sidebar" }).locator("a[data-account-id]").filter({ has: page.locator("span", { hasText: /^Checking$/ }) }).click();
  }
  await page.waitForURL(/\/accounts\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { name: "Checking", level: 1 })).toBeVisible();
  const chart = page.getByTestId("balance-chart");
  await expect(chart).toBeVisible();
  expect(Number(await chart.getAttribute("data-points"))).toBeGreaterThan(60);
  expect((await page.getByTestId("chart-line").getAttribute("d"))!.length).toBeGreaterThan(200);
  const ranges = page.getByRole("radiogroup", { name: "Range" });
  await ranges.getByRole("radio", { name: "1M" }).click();
  await expect(chart).toHaveAttribute("data-points", "30");
  await ranges.getByRole("radio", { name: "All" }).click();
  expect(Number(await chart.getAttribute("data-points"))).toBeGreaterThan(300);
  const box = (await chart.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await expect(page.getByText(/^(Sun|Mon|Tue|Wed|Thu|Fri|Sat), \w{3} \d+, 20\d\d$/)).toBeVisible();
  await expect(page.getByRole("listbox", { name: "Transactions" }).locator("li").first()).toBeVisible();
});
