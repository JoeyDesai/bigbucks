/**
 * Visual review for buckets: overflow (rollover). Alex's Spending Money rolls over since August with
 * $175 already saved, Sam's starts this month. Dark theme, 390×844 and 1440×900: the Budget page at
 * the Wants group, the sheet of a bucket that has been rolling over, and one in its first month
 * ("Already saved"). DATABASE_URL must point at the server's database. Output: test-results/screens/rollover/.
 * Run: `SCREENS=1 pnpm exec playwright test rollover-screens --project=desktop`.
 */
import { mkdirSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { createDb } from "@homebase/db";

const OUT = "test-results/screens/rollover";
const SIZES = [
  [390, 844],
  [1440, 900],
] as const;

test.describe.configure({ mode: "serial" });
test.skip(({ isMobile }) => isMobile, "captures set their own viewport; run once on the desktop project");
test.skip(() => !process.env.SCREENS, "visual captures: set SCREENS=1");

const db = process.env.DATABASE_URL ? createDb(process.env.DATABASE_URL, { max: 1 }) : null;
const ALEX = "Alex's Spending Money";
const SAM = "Sam's Spending Money";

test.beforeAll(async () => {
  mkdirSync(OUT, { recursive: true });
  if (!db) return;
  await db.pool.query("UPDATE categories SET rollover = true, rollover_from = '2026-08-01', rollover_opening_milli = 175000 WHERE name = $1", [ALEX]);
  await db.pool.query("UPDATE categories SET rollover = true, rollover_from = date_trunc('month', now() AT TIME ZONE 'America/New_York')::date, rollover_opening_milli = 0 WHERE name = $1", [SAM]);
});
test.afterAll(async () => {
  await db?.pool.query("UPDATE categories SET rollover = false WHERE name = ANY($1)", [[ALEX, SAM]]);
  await db?.pool.end();
});

async function openSheet(page: Page, name: string) {
  await page.getByRole("button", { name: `${name} details` }).click();
  const sheet = page.getByRole("dialog", { name: new RegExp(name) });
  await expect(sheet.getByRole("region", { name: "Overflow" })).toBeVisible();
  await page.waitForTimeout(900);
  return sheet;
}

test("rollover captures (dark)", async ({ page, context, baseURL }) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(() => localStorage.setItem("hb_install_hint_dismissed", "1"));
  await context.addCookies([{ name: "hb_theme", value: "dark", url: baseURL! }]);
  for (const [w, h] of SIZES) {
    await page.setViewportSize({ width: w, height: h });
    const tag = `dark-${w}`;
    await page.goto("/budget");
    await page.waitForLoadState("networkidle");
    const row = page.locator("[data-category-id]").filter({ has: page.getByRole("button", { name: `${ALEX} details` }) });
    await expect(row.getByTestId("rollover-icon")).toBeVisible();
    await page.waitForTimeout(2600);
    await page.screenshot({ path: `${OUT}/${tag}-budget-top.png` });
    await row.evaluate((el) => el.scrollIntoView({ block: "center" }));
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${OUT}/${tag}-budget.png` });
    let sheet = await openSheet(page, ALEX);
    await expect(sheet.getByTestId("rollover-note")).toHaveText(/rolled over/);
    await page.screenshot({ path: `${OUT}/${tag}-sheet.png` });
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
    sheet = await openSheet(page, SAM);
    await expect(sheet.getByRole("button", { name: /^Already saved in/ })).toBeVisible();
    await page.screenshot({ path: `${OUT}/${tag}-sheet-first-month.png` });
    await page.keyboard.press("Escape");
  }
  expect(errors).toEqual([]);
});
