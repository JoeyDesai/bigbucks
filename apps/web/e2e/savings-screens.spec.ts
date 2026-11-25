/**
 * Visual review for buckets: savings buckets. Taxes, Emergency Fund and House Projects become savings
 * buckets (House Projects with a $15,000 target, the Emergency Fund with its $20,000 goal as target).
 * Dark theme, 390×844 and 1440×900: the Budget page at the Savings card, the "+ Add" popover with an
 * amount typed, and the savings bucket sheet. DATABASE_URL must point at the server's database.
 * Output: test-results/screens/savings/.
 * Run: `SCREENS=1 pnpm exec playwright test savings-screens --project=desktop`.
 */
import { mkdirSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { createDb } from "@homebase/db";

const OUT = "test-results/screens/savings";
const SIZES = [
  [390, 844],
  [1440, 900],
] as const;

test.describe.configure({ mode: "serial" });
test.skip(({ isMobile }) => isMobile, "captures set their own viewport; run once on the desktop project");
test.skip(() => !process.env.SCREENS, "visual captures: set SCREENS=1");

const db = process.env.DATABASE_URL ? createDb(process.env.DATABASE_URL, { max: 1 }) : null;
const SAVINGS: [string, number, number | null][] = [
  ["Taxes", 3_200_000, null],
  ["Emergency Fund", 14_500_000, 20_000_000],
  ["House Projects", 1_800_000, 15_000_000],
];

test.beforeAll(async () => {
  mkdirSync(OUT, { recursive: true });
  if (!db) return;
  for (const [name, opening, target] of SAVINGS)
    await db.pool.query(
      "UPDATE categories SET bucket_kind = 'savings', rollover = false, rollover_from = date_trunc('month', now() AT TIME ZONE 'America/New_York')::date, rollover_opening_milli = $2, savings_target_milli = $3 WHERE name = $1 AND bucket_kind = 'spending'",
      [name, opening, target],
    );
});
test.afterAll(async () => {
  await db?.pool.end();
});

test("savings captures (dark)", async ({ page, context, baseURL }) => {
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
    const card = page.getByTestId("savings-card");
    await expect(card).toBeVisible();
    await page.waitForTimeout(2600);
    await page.screenshot({ path: `${OUT}/${tag}-budget-top.png` });
    await card.evaluate((el) => el.scrollIntoView({ block: "start" }));
    await page.evaluate(() => window.scrollBy(0, -12));
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${OUT}/${tag}-savings-card.png` });
    const tile = card.locator("[data-category-id]").filter({ hasText: "House Projects" });
    await tile.getByTestId("savings-add").click();
    const pop = page.getByRole("dialog", { name: "Add to House Projects" });
    await expect(pop).toBeVisible();
    await pop.getByRole("button", { name: "$250" }).click();
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${OUT}/${tag}-add-popover.png` });
    await pop.getByRole("radio", { name: "Take out" }).click();
    await page.waitForTimeout(250);
    await page.screenshot({ path: `${OUT}/${tag}-take-out.png` });
    await page.keyboard.press("Escape");
    await expect(pop).toBeHidden();
    await card.getByRole("button", { name: "Emergency Fund details" }).click();
    const sheet = page.getByRole("dialog", { name: /Emergency Fund/ });
    await expect(sheet.getByTestId("savings-history")).toBeVisible();
    await page.waitForTimeout(900);
    await page.screenshot({ path: `${OUT}/${tag}-sheet.png` });
    await page.keyboard.press("Escape");
  }
  expect(errors).toEqual([]);
});
