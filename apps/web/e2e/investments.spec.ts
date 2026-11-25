import { expect, test } from "@playwright/test";

/** Investments tab against the demo seed: Litware brokerage + 401k, Proseware 401k, Coinbase, River. */
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("hb_install_hint_dismissed", "1"));
});

test("overview adds up, an account opens on its own, and the range switches", async ({ page }, info) => {
  await page.goto("/investments");
  const total = page.getByTestId("invest-total");
  await expect(total).toBeVisible();
  const all = BigInt((await total.getAttribute("data-value"))!);
  expect(all).toBeGreaterThan(0n);

  const rows = page.getByTestId("invest-accounts").locator(":scope > li");
  await expect(rows).toHaveCount(5);
  await expect(page.getByTestId("invest-holdings").getByText("FXAIX")).toBeVisible();
  await expect(page.getByTestId("invest-growth")).toBeVisible();

  await rows.filter({ hasText: "Litware Brokerage" }).getByRole("button").first().click();
  await expect(page).toHaveURL(/\/investments\?a=[0-9a-f-]{36}$/);
  await expect(page.getByTestId("invest-account-select")).toHaveValue(/^[0-9a-f-]{36}$/);
  await expect(page.getByTestId("invest-accounts")).toHaveCount(0);
  const one = BigInt((await total.getAttribute("data-value"))!);
  expect(one).toBeGreaterThan(0n);
  expect(one).toBeLessThan(all);
  await expect(page.getByTestId("invest-holdings").getByText("FXAIX")).toBeVisible();
  await expect(page.getByTestId("invest-holdings").getByText("FDEEX")).toHaveCount(0);
  await expect(page.getByTestId("invest-stats")).toContainText("Holdings");

  // a fund opens its own chart and numbers; Price switches the chart
  await page.getByTestId("invest-holdings").getByRole("button", { name: /FZILX/ }).click();
  const fund = page.getByTestId("invest-fund");
  await expect(fund.getByRole("heading", { name: "FZILX" })).toBeVisible();
  await expect(fund.getByTestId("invest-chart")).toBeVisible();
  await fund.getByRole("button", { name: "Price" }).click();
  await expect(fund.getByRole("button", { name: "Price" })).toHaveAttribute("aria-pressed", "true");

  await page.getByRole("group", { name: "Time range" }).getByRole("button", { name: "3M" }).click();
  await expect(page).toHaveURL(/p=3M/);
  await expect(page.getByText("past 3 months", { exact: true })).toBeVisible();
  await page.screenshot({ path: `test-results/screens/${info.project.name}/investments-account.png`, fullPage: true });

  await page.getByTestId("invest-account-select").selectOption("");
  await expect(page.getByTestId("invest-accounts")).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test("an account can be hidden from Investments and shown again", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "one settings write is enough");
  await page.goto("/investments");
  const rows = page.getByTestId("invest-accounts").locator(":scope > li");
  await expect(rows).toHaveCount(5);
  const total = BigInt((await page.getByTestId("invest-total").getAttribute("data-value"))!);

  // right-click opens the row's menu
  await rows.filter({ hasText: "Coinbase" }).click({ button: "right", position: { x: 40, y: 20 } });
  await page.getByRole("menuitem", { name: "Hide from Investments" }).click();
  await expect(rows).toHaveCount(4);
  await expect(page.getByTestId("invest-hidden")).toContainText("1 hidden or empty account");
  expect(BigInt((await page.getByTestId("invest-total").getAttribute("data-value"))!)).toBeLessThan(total);

  await page.getByTestId("invest-hidden").locator("summary").click();
  await page.getByTestId("invest-hidden").getByRole("button", { name: "Show" }).click();
  await expect(rows).toHaveCount(5);
  await expect(page.getByTestId("invest-hidden")).toHaveCount(0);
});

test("the investment picker finds built-in assets as you type", async ({ page }) => {
  await page.goto("/investments");
  await page.locator("#add-investment summary").click();
  const box = page.getByRole("combobox", { name: "What is it?" });
  await box.fill("eth");
  await expect(page.getByTestId("asset-options").getByRole("option").first()).toContainText("Ethereum");
  await box.fill("fxai");
  await expect(page.getByTestId("asset-options").getByRole("option").first()).toContainText("FXAIX");
  await expect(page.getByTestId("asset-options")).toContainText("Something else");
});

