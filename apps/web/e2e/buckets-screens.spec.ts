/**
 * Visual review captures for the simple bucket budget (glow): Budget mid-animation and settled,
 * Transactions with the picker open and with the shortcut sheet, and an account page — light and dark,
 * Alex (blue, dev bypass) and Sam (pink, a real DB session), 390×844 and 1440×900.
 * DATABASE_URL must point at the server's database (for Sam's session). Output: test-results/screens/buckets/.
 * Run on its own: `pnpm exec playwright test buckets-screens --project=desktop`.
 */
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { createDb } from "@homebase/db";
import { createSession, deleteSession } from "@homebase/core";

const OUT = "test-results/screens/buckets";
const SIZES = [
  [390, 844],
  [1440, 900],
] as const;

test.describe.configure({ mode: "serial" });
test.skip(({ isMobile }) => isMobile, "captures set their own viewport; run once on the desktop project");
test.skip(() => !process.env.SCREENS, "visual captures: set SCREENS=1");

const db = process.env.DATABASE_URL ? createDb(process.env.DATABASE_URL, { max: 1 }) : null;
let sam: string | null = null;
let checking: string | null = null;
test.beforeAll(async () => {
  if (!db) return;
  const r = await db.pool.query<{ id: string }>("SELECT id FROM users WHERE display_name = 'Sam' LIMIT 1");
  if (r.rows[0]) sam = (await createSession(db.db, { userId: r.rows[0].id, userAgent: "playwright screens" })).token;
  const a = await db.pool.query<{ id: string }>("SELECT id FROM accounts WHERE name = 'Checking' AND deleted_at IS NULL LIMIT 1");
  checking = a.rows[0]?.id ?? null;
});
test.afterAll(async () => {
  if (db && sam) await deleteSession(db.db, sam);
  await db?.pool.end();
});

async function capture(page: Page, context: BrowserContext, who: string, baseURL: string) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  for (const scheme of ["light", "dark"] as const) {
    await context.addCookies([{ name: "hb_theme", value: scheme, url: baseURL }]);
    for (const [w, h] of SIZES) {
      await page.setViewportSize({ width: w, height: h });
      const tag = `${who}-${scheme}-${w}`;
      // Budget: replay the fill by switching months client-side, shoot mid-animation and settled
      await page.goto("/budget?m=2026-09");
      await page.waitForLoadState("networkidle");
      await page.waitForTimeout(600);
      await page.getByRole("link", { name: /^Next month/ }).filter({ visible: true }).first().click();
      await page.locator('[data-month="2026-10-01"]').waitFor();
      await page.waitForTimeout(380);
      await page.screenshot({ path: `${OUT}/${tag}-budget-mid.png` });
      await page.waitForTimeout(2600);
      await page.screenshot({ path: `${OUT}/${tag}-budget.png` });
      // Transactions: the picker, then the cheat sheet
      await page.goto("/transactions");
      await page.waitForLoadState("networkidle");
      await page.waitForTimeout(700);
      if (w < 500) {
        await page.locator("[data-chip]").nth(1).click();
      } else {
        await page.keyboard.press("ArrowDown");
        await page.keyboard.press("g");
        await page.keyboard.type("r");
      }
      await page.waitForTimeout(600);
      await page.screenshot({ path: `${OUT}/${tag}-transactions-picker.png` });
      await page.keyboard.press("Escape");
      await page.waitForTimeout(400);
      await page.keyboard.press("?");
      await page.waitForTimeout(600);
      await page.screenshot({ path: `${OUT}/${tag}-transactions-shortcuts.png` });
      await page.keyboard.press("Escape");
      // an account page, scrubbing the chart
      if (checking) {
        await page.goto(`/accounts/${checking}`);
        await page.waitForLoadState("networkidle");
        await page.waitForTimeout(1500);
        const box = await page.getByTestId("balance-chart").boundingBox();
        if (box && w > 500) await page.mouse.move(box.x + box.width * 0.62, box.y + box.height * 0.5);
        await page.waitForTimeout(300);
        await page.screenshot({ path: `${OUT}/${tag}-account.png` });
      }
    }
  }
  expect(errors).toEqual([]);
}

test("Alex (blue)", async ({ page, context, baseURL }) => {
  test.setTimeout(600_000);
  await page.addInitScript(() => localStorage.setItem("hb_install_hint_dismissed", "1"));
  await capture(page, context, "alex", baseURL!);
});

test("Sam (pink)", async ({ page, context, baseURL }) => {
  test.skip(!sam, "needs DATABASE_URL and a seeded Sam");
  test.setTimeout(600_000);
  await context.addCookies([{ name: "hb_session", value: sam!, url: baseURL! }]);
  await page.addInitScript(() => localStorage.setItem("hb_install_hint_dismissed", "1"));
  await page.goto("/settings");
  test.skip((await page.getByText(/^Member · Signed in with PIN$/).count()) === 0, "the server isn't reading sessions from this DATABASE_URL");
  await capture(page, context, "sam", baseURL!);
});
