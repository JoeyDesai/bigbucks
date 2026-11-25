import { expect, test } from "@playwright/test";

const ROUTES = ["/budget", "/transactions", "/accounts", "/investments", "/reflect", "/plan", "/activity", "/wealth", "/reports", "/reports/more", "/ask", "/settings", "/health", "/dev/kit"];

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("hb_install_hint_dismissed", "1"));
});

for (const path of ROUTES) {
  test(`renders ${path}`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const res = await page.goto(path);
    expect(res?.status()).toBeLessThan(400);
    await expect(page.locator("h1").first()).toBeAttached();
    expect(errors).toEqual([]);
  });
}

test("every account has a wealth and a register page", async ({ page }) => {
  await page.goto("/wealth");
  const hrefs = await page.locator('a[href^="/wealth/"]').evaluateAll((as) => as.map((a) => a.getAttribute("href")!));
  expect(hrefs.length).toBeGreaterThan(5);
  for (const href of hrefs) {
    const r = await page.goto(href);
    expect(r?.status(), href).toBe(200);
    const r2 = await page.goto(href.replace("/wealth/", "/activity/"));
    expect(r2?.status(), href).toBe(200);
  }
});

test("/ goes to Budget; the main nav is Budget, Transactions, Investments, Reflect", async ({ page, isMobile }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/budget$/);
  const nav = page.getByRole("navigation", { name: "Primary" }).filter({ visible: true });
  await expect(nav.getByRole("link", { name: /^Budget/ })).toHaveAttribute("aria-current", "page");
  for (const gone of ["Wealth", "Ask", "Plan", "Reports"]) await expect(nav.getByRole("link", { name: gone })).toHaveCount(0);
  await nav.getByRole("link", { name: /Transactions/ }).click();
  await expect(page).toHaveURL(/\/transactions$/);
  await expect(nav.getByRole("link", { name: /Transactions/ })).toHaveAttribute("aria-current", "page");
  if (isMobile) await expect(nav.getByRole("link", { name: /Accounts/ })).toBeVisible();
  expect(page.url()).not.toContain("#");
});

test("the avatar menu holds Settings, the theme and the older screens", async ({ page }) => {
  await page.goto("/budget");
  const open = () => page.getByRole("button", { name: /^Account menu for / }).filter({ visible: true }).first().click();
  await open();
  const menu = page.getByRole("menu");
  for (const item of ["Settings", "Keyboard shortcuts", "Classic plan", "Reports", "Wealth", "Ask"]) await expect(menu.getByRole("menuitem", { name: item })).toBeVisible();
  await menu.getByRole("menuitemradio", { name: "Dark" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await open();
  await page.getByRole("menu").getByRole("menuitemradio", { name: "Light" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await open();
  await page.getByRole("menu").getByRole("menuitem", { name: "Classic plan" }).click();
  await expect(page).toHaveURL(/\/plan$/);
});

test("category details: inspector on desktop, bottom sheet on phones", async ({ page, isMobile }) => {
  await page.goto("/plan");
  await page.getByRole("button", { name: "Groceries details" }).click();
  if (isMobile) {
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("region", { name: "Recent transactions" }).locator("li").first()).toBeVisible();
    await expect(dialog.getByRole("region", { name: "Target" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  } else {
    const inspector = page.getByRole("complementary", { name: "Inspector" });
    await expect(inspector.getByRole("heading", { name: "Groceries" })).toBeVisible();
    await expect(inspector.getByRole("region", { name: "Recent transactions" }).locator("li").first()).toBeVisible();
    await expect(inspector.getByRole("img", { name: /% funded/ })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(inspector.getByRole("region", { name: "Cost to Be Me" })).toBeVisible();
  }
});

test("category icon picker sets an icon", async ({ page, isMobile }) => {
  test.skip(isMobile, "once is enough");
  await page.goto("/plan");
  await page.getByRole("button", { name: "Dates details" }).click();
  const inspector = page.getByRole("complementary", { name: "Inspector" });
  await inspector.getByRole("button", { name: "Change icon for Dates" }).click();
  await inspector.getByPlaceholder(/Search icons/).fill("wine");
  await inspector.getByRole("option", { name: "wine" }).click();
  await expect(page.getByText("Icon updated for Dates")).toBeVisible();
  await page.reload();
  await expect(page.locator('[data-category-id] [data-icon="wine"]').first()).toBeVisible();
});

test("the classic plan still shows Ready to Assign and the YNAB filter chips", async ({ page }) => {
  await page.goto("/plan");
  await expect(page.getByRole("region", { name: "Ready to Assign" }).filter({ visible: true })).toBeVisible();
  const chips = page.getByRole("radiogroup", { name: "Filter categories" });
  for (const c of ["All", "Overspent", "Underfunded", "Overfunded", "Money Available", "Snoozed"]) await expect(chips.getByRole("radio", { name: new RegExp(c) })).toBeVisible();
  await expect(page.getByRole("link", { name: /Uncategorized Transactions/ })).toBeVisible();
});

test("wealth period switch updates the URL", async ({ page }) => {
  await page.goto("/wealth");
  await page.getByRole("radio", { name: "3M" }).click();
  await expect(page).toHaveURL(/p=3M/);
});

test("manifest is served", async ({ request }) => {
  const res = await request.get("/manifest.webmanifest");
  expect(res.ok()).toBeTruthy();
  const m = await res.json();
  expect(m.name).toBe("Big Bucks");
  expect(m.start_url).toBe("/budget");
  expect(m.display).toBe("standalone");
});

test("activity reads the reports drill-down params", async ({ page }) => {
  await page.goto("/activity?from=2026-10-01&to=2026-10-31");
  await expect(page.getByText(/^Showing/).filter({ visible: true })).toContainText("Oct 1, 2026");
  await page.getByRole("link", { name: "Clear filters" }).click();
  await expect(page).toHaveURL(/\/activity$/);
});

test("plan shows recent moves and hidden categories", async ({ page }) => {
  await page.goto("/plan");
  await page.getByRole("button", { name: "Recent moves" }).filter({ visible: true }).first().click();
  await expect(page.getByRole("dialog", { name: "Recent moves" })).toBeVisible();
  await page.keyboard.press("Escape");
  const toggle = page.getByRole("button", { name: /Hidden Categories/ });
  if (await toggle.count()) {
    await toggle.click();
    await expect(page.getByRole("dialog", { name: "Hidden categories" }).getByRole("button", { name: /^Unhide / }).first()).toBeVisible();
  }
});

test("accent color follows the user and can be changed in Settings", async ({ page }) => {
  await page.goto("/settings");
  const html = page.locator("html");
  const saved = async () => {
    await page.reload();
    return html.getAttribute("data-accent");
  };
  await page.getByRole("radio", { name: "Teal" }).click();
  await expect(html).toHaveAttribute("data-accent", "teal");
  await expect.poll(saved, { timeout: 15_000 }).toBe("teal");
  // a custom color (Settings → You → Custom)
  await page.getByLabel("Pick a custom accent color").evaluate((el: HTMLInputElement) => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    set.call(el, "#ff8800");
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.focus();
    el.blur();
  });
  await expect.poll(saved, { timeout: 15_000 }).toBe("custom");
  await expect(html).toHaveAttribute("style", /--accent-l: ?#ff8800/);
  await page.getByRole("radio", { name: "Blue" }).click();
  await expect(html).toHaveAttribute("data-accent", "blue");
  await expect.poll(saved, { timeout: 15_000 }).toBe("blue");
});
