/**
 * Ask + Settings smoke (runs against the dev server with HOMEBASE_DEV_USER=alex, the demo seed and no
 * Anthropic key). Member checks use a real DB session for Sam, so DATABASE_URL must point at the same
 * database as the server.
 */
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { createDb } from "@homebase/db";
import { createSession, deleteSession } from "@homebase/core";

const SETTINGS = ["connections", "accounts", "categories", "targets", "rules", "payees", "memory", "notifications", "imports", "ai", "users", "backups"] as const;
const ADMIN_ONLY = ["connections", "users", "ai", "backups"] as const;
const TITLES: Record<(typeof SETTINGS)[number], string> = {
  connections: "Connections",
  accounts: "Accounts",
  categories: "Edit buckets",
  targets: "Targets",
  rules: "Rules",
  payees: "Payees",
  memory: "Household memory",
  notifications: "Notifications",
  imports: "Imports",
  ai: "AI",
  users: "Users & PINs",
  backups: "Backups",
};

test.describe("Ask", () => {
  test("empty state shows the suggested prompts and the missing-key message", async ({ page }) => {
    await page.goto("/ask");
    await expect(page.getByText("What do you want to know?")).toBeVisible();
    await expect(page.getByRole("button", { name: "Where did all our money go in September?" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Fund all underfunded categories with what's left to assign." })).toBeVisible();
    await expect(page.getByText(/Add an Anthropic API key in Settings → AI/)).toBeVisible();
    // Composer is disabled until a key exists; the mic and speaker controls are present.
    await expect(page.getByRole("textbox", { name: "Ask a question" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Hold to talk" })).toBeVisible();
    await expect(page.getByRole("button", { name: /Speak replies/ })).toBeVisible();
  });

  test("POST /api/ask without a key streams the setup message", async ({ request }) => {
    const res = await request.post("/api/ask", { data: { message: "How much is left to assign?" } });
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("text/event-stream");
    const body = await res.text();
    expect(body).toContain("event: error");
    expect(body).toContain("Add an Anthropic API key in Settings");
  });
});

test.describe("Settings as admin", () => {
  for (const slug of SETTINGS) {
    test(`/settings/${slug} renders`, async ({ page }) => {
      const res = await page.goto(`/settings/${slug}`);
      expect(res?.status()).toBe(200);
      await expect(page.getByRole("heading", { level: 1, name: TITLES[slug] })).toBeVisible();
    });
  }
});

test.describe("Settings as a member", () => {
  const db = process.env.DATABASE_URL ? createDb(process.env.DATABASE_URL, { max: 1 }) : null;
  let token: string | null = null;

  test.beforeAll(async () => {
    if (!db) return;
    const r = await db.pool.query<{ id: string }>("SELECT id FROM users WHERE role = 'member' ORDER BY created_at LIMIT 1");
    if (!r.rows[0]) return;
    token = (await createSession(db.db, { userId: r.rows[0].id, userAgent: "playwright" })).token;
  });
  test.afterAll(async () => {
    if (db && token) await deleteSession(db.db, token);
    await db?.pool.end();
  });
  /** Sign in as the member; skips when the server isn't reading sessions from this database. */
  const asMember = async (page: Page, context: BrowserContext, baseURL: string | undefined) => {
    await context.addCookies([{ name: "hb_session", value: token!, url: baseURL ?? "http://127.0.0.1:3100" }]);
    await page.goto("/settings");
    const member = await page.getByText(/^Member · Signed in with PIN$/).count();
    test.skip(member === 0, "the dev server isn't using DB identity stores for this DATABASE_URL (start it with DATABASE_URL set)");
  };

  for (const slug of ADMIN_ONLY) {
    test(`/settings/${slug} is a 404`, async ({ page, context, baseURL }) => {
      test.skip(!token, "needs DATABASE_URL and a seeded member");
      await asMember(page, context, baseURL);
      const res = await page.goto(`/settings/${slug}`);
      expect(res?.status()).toBe(404);
    });
  }
  test("household sections still render, admin ones are hidden from the list", async ({ page, context, baseURL }) => {
    test.skip(!token, "needs DATABASE_URL and a seeded member");
    await asMember(page, context, baseURL);
    expect((await page.goto("/settings/memory"))?.status()).toBe(200);
    await page.goto("/settings");
    await expect(page.getByRole("link", { name: /Household memory/ })).toBeVisible();
    await expect(page.getByRole("main").getByRole("link", { name: /Connections/ })).toHaveCount(0);
    const api = await page.request.get("/api/ask/conversations");
    expect(api.status()).toBe(200);
  });
});

test.describe("screens", () => {
  const PAGES = ["ask", "settings/ai", "settings/connections", "settings/rules", "settings/notifications", "settings/imports", "settings/categories", "settings/memory", "settings/users"];
  for (const [w, h] of [
    [390, 844],
    [1440, 900],
  ] as const) {
    for (const p of PAGES) {
      test(`screenshot ${p} ${w}`, async ({ page }, info) => {
        test.skip(info.project.name !== "desktop", "one capture per viewport");
        await page.setViewportSize({ width: w, height: h });
        await page.goto(`/${p}`);
        await page.waitForTimeout(1200);
        await page.screenshot({ path: `test-results/screens/ask-settings/${p.replace("/", "-")}-${w}.png`, fullPage: w === 1440 });
      });
    }
  }
});
