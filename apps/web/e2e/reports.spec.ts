import { expect, test, type Page } from "@playwright/test";

/**
 * §13 reports render with data on iPhone 15 and desktop. Full-page captures go to
 * test-results/screens/reports/<project>/ for visual review. Needs a demo-seeded database.
 */
const REPORTS = [
  "spending-breakdown",
  "spending-trends",
  "income-vs-expense",
  "net-worth",
  "age-of-money",
  "category-detail",
  "payees",
  "cash-flow",
  "investment-growth",
  "budget-performance",
  "subscriptions",
] as const;

const shot = (project: string, name: string) => `test-results/screens/reports/${project}/${name}.png`;

/**
 * Full-length capture without Playwright's fullPage mode, which resizes the viewport at capture time
 * and restarts chart animations (bars would be caught at zero height).
 */
async function capture(page: Page, path: string): Promise<void> {
  const vp = page.viewportSize()!;
  const h = await page.evaluate(() => document.documentElement.scrollHeight);
  await page.setViewportSize({ width: vp.width, height: Math.min(h, 9000) });
  await page.waitForTimeout(1200);
  await page.screenshot({ path });
  await page.setViewportSize(vp);
}

test("Reflect opens on Spending Breakdown with YNAB's tabs", async ({ page }) => {
  await page.goto("/reports");
  await expect(page).toHaveURL(/\/reports\/spending-breakdown$/);
  await expect(page.getByRole("heading", { name: "Reflect", level: 1 })).toBeVisible();
  const tabs = page.getByRole("navigation", { name: "Reflect" });
  for (const t of ["Spending Breakdown", "Spending Trends", "Net Worth", "Income v Expense", "Age of Money", "More"]) await expect(tabs.getByRole("link", { name: t, exact: true })).toBeVisible();
  await expect(tabs.getByRole("link", { name: "Spending Breakdown" })).toHaveAttribute("aria-current", "page");
  await tabs.getByRole("link", { name: "More", exact: true }).click();
  await expect(page).toHaveURL(/\/reports\/more$/);
});

test("the More tab lists every report with live figures", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/reports/more");
  await expect(page.getByRole("heading", { name: "Reflect", level: 1 })).toBeVisible();
  const nav = page.getByRole("navigation", { name: "Reports" });
  for (const title of ["Spending breakdown", "Net worth", "Age of Money", "Subscriptions", "Saved reports"]) await expect(nav.getByText(title, { exact: true })).toBeVisible();
  await expect(page.locator("aside [role=img] svg").first()).toBeVisible();
  await capture(page, shot(info.project.name, "index"));
  expect(errors).toEqual([]);
});

for (const slug of REPORTS) {
  test(`report ${slug} renders a chart and a table`, async ({ page }, info) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`/reports/${slug}`);
    await expect(page.locator("h1")).toBeVisible();
    const chart = page.locator("[data-report-chart] [role=img]").first();
    await expect(chart).toBeVisible();
    await expect(chart.locator("svg").first()).toBeVisible({ timeout: 15_000 });
    const rows = page.locator("table tbody tr");
    expect(await rows.count()).toBeGreaterThan(1);
    await expect(page.getByText("Nothing in this period.")).toHaveCount(0);
    // no horizontal overflow on phones
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    await capture(page, shot(info.project.name, slug));
    expect(errors).toEqual([]);
  });
}

test("filters change the period and level through the URL", async ({ page }, info) => {
  await page.goto("/reports/spending-breakdown");
  await page.getByRole("radio", { name: "12 mo" }).click();
  await expect(page).toHaveURL(/period=last12/);
  await expect(page.getByText("Last 12 months").first()).toBeVisible();
  await page.getByRole("radio", { name: "Groups" }).click();
  await expect(page).toHaveURL(/level=group/);
  await expect(page.locator("table tbody tr").filter({ hasText: "Bills" }).first()).toBeVisible();
  await page.getByRole("radio", { name: "Month" }).click();
  await expect(page).not.toHaveURL(/period=/);
  await page.getByRole("button", { name: "Previous month" }).click();
  await expect(page).toHaveURL(/m=2026-09/);
  await expect(page.getByText("September 2026").first()).toBeVisible();
  await page.getByRole("radio", { name: "Custom" }).click();
  await expect(page.getByLabel("From")).toBeVisible();
  await expect(page.getByRole("radio", { name: "Custom" })).toHaveAttribute("aria-checked", "true");
  await page.getByLabel("From").fill("2026-08-15");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page).toHaveURL(/period=custom&from=2026-08-15&to=2026-09-30/);
  await expect(page.getByText("Aug 15 – Sep 30, 2026").first()).toBeVisible();
  await page.screenshot({ path: shot(info.project.name, "filters-custom"), fullPage: false });
});

test("rows drill down to Activity with filters", async ({ page }) => {
  await page.goto("/reports/spending-breakdown");
  const link = page.locator("table tbody tr a").first();
  const href = await link.getAttribute("href");
  expect(href).toMatch(/^\/activity\?category=[0-9a-f-]+&from=\d{4}-\d{2}-01&to=\d{4}-\d{2}-\d{2}$/);
});

test("exports CSV and PNG", async ({ page }) => {
  await page.goto("/reports/income-vs-expense");
  const csv = await page.request.get("/reports/income-vs-expense/export?period=last12");
  expect(csv.status()).toBe(200);
  expect(csv.headers()["content-type"]).toContain("text/csv");
  const text = await csv.text();
  expect(text.split("\r\n")[0]).toBe("Month,Income,Expense,Net,Saved");
  expect(text.trim().split("\r\n").length).toBe(14);
  await expect(page.locator("[data-report-chart] svg").first()).toBeVisible();
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "PNG" }).click()]);
  expect(download.suggestedFilename()).toMatch(/^income-vs-expense-.*\.png$/);
});

test("saved reports list and the seeded live query", async ({ page }, info) => {
  await page.goto("/reports/saved");
  await expect(page.getByRole("heading", { name: "Saved reports" })).toBeVisible();
  await page.getByRole("link", { name: /Eating out/ }).first().click();
  await expect(page.locator("[data-report-chart] svg").first()).toBeVisible({ timeout: 15_000 });
  await capture(page, shot(info.project.name, "saved-query"));
});
