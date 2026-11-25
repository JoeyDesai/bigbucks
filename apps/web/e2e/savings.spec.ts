import { expect, test, type Page } from "@playwright/test";

/**
 * Buckets: savings buckets (ADR "Buckets: savings buckets") on seeded demo data: make Taxes a savings
 * bucket in Edit buckets, add money from the Budget page's Savings card (the balance goes up, "left to
 * spend" doesn't move, it survives a reload, Undo takes it back), refuse taking out more than the
 * balance, then make it a spending bucket again so the next project starts clean.
 */
test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("hb_install_hint_dismissed", "1"));
});

const NAME = "Taxes";

async function setSavings(page: Page, on: boolean) {
  await page.goto("/settings/categories");
  const btn = page.getByRole("button", { name: on ? `Make ${NAME} a savings bucket` : `Make ${NAME} a spending bucket` });
  if (!(await btn.isVisible())) return;
  await btn.click();
  await expect(page.getByRole("button", { name: on ? `Make ${NAME} a spending bucket` : `Make ${NAME} a savings bucket` })).toBeVisible();
}

const leftToSpend = (page: Page) => page.getByRole("region", { name: "This month" }).locator("[data-value]").first();

test("savings bucket: add money, the balance grows and left to spend stays put", async ({ page }) => {
  await setSavings(page, true);
  await expect(page.getByRole("button", { name: `Make ${NAME} a spending bucket` })).toHaveAttribute("aria-pressed", "true");

  await page.goto("/budget");
  const card = page.getByTestId("savings-card");
  await expect(card).toBeVisible();
  // a savings bucket is not a spending row any more
  await expect(page.getByTestId("buckets").getByRole("button", { name: `${NAME} details` })).toHaveCount(0);
  const tile = card.locator("[data-category-id]").filter({ hasText: NAME });
  const before = BigInt((await tile.getAttribute("data-balance"))!);
  const left = await leftToSpend(page).getAttribute("data-value");
  await expect(card.getByTestId("savings-income")).toHaveText(/^Income this month \$[\d,]+ · /);

  await tile.getByTestId("savings-add").click();
  const pop = page.getByRole("dialog", { name: `Add to ${NAME}` });
  const field = pop.getByLabel(`Amount to add to ${NAME}`);
  await expect(field).toBeFocused();
  await field.fill("250");
  await page.keyboard.press("Enter");
  await expect(pop).toBeHidden();
  await expect(tile).toHaveAttribute("data-balance", String(before + 250_000n));
  const toast = page.getByRole("status").filter({ hasText: `Added $250 to ${NAME}` });
  await expect(toast).toBeVisible();
  expect(await leftToSpend(page).getAttribute("data-value")).toBe(left);

  // the server agrees
  await page.reload();
  await expect(tile).toHaveAttribute("data-balance", String(before + 250_000n));
  expect(await leftToSpend(page).getAttribute("data-value")).toBe(left);

  // quick amount, then Undo
  await tile.getByTestId("savings-add").click();
  await pop.getByRole("button", { name: "$100" }).click();
  await pop.getByTestId("savings-submit").click();
  await expect(tile).toHaveAttribute("data-balance", String(before + 350_000n));
  await page.getByRole("status").filter({ hasText: `Added $100 to ${NAME}` }).getByRole("button", { name: "Undo" }).click();
  await expect(tile).toHaveAttribute("data-balance", String(before + 250_000n));

  // can't take out more than the balance
  await tile.getByTestId("savings-add").click();
  await pop.getByRole("radio", { name: "Take out" }).click();
  await pop.getByLabel(`Amount to take out of ${NAME}`).fill(String(Number(before + 250_000n) / 1000 + 1));
  await page.keyboard.press("Enter");
  await expect(pop.getByRole("alert")).toHaveText(/^Only \$[\d,.]+ to take out$/);
  await pop.getByLabel(`Amount to take out of ${NAME}`).fill("50");
  await page.keyboard.press("Enter");
  await expect(tile).toHaveAttribute("data-balance", String(before + 200_000n));

  // the sheet: balance, history, no monthly goal or overflow
  await card.getByRole("button", { name: `${NAME} details` }).click();
  const sheet = page.getByRole("dialog", { name: new RegExp(NAME) });
  await expect(sheet.getByTestId("savings-balance")).toHaveAttribute("data-value", String(before + 200_000n));
  await expect(sheet.getByTestId("savings-history")).toContainText("Added");
  await expect(sheet.getByTestId("savings-history")).toContainText("Taken out");
  await expect(sheet.getByRole("region", { name: "Goal" })).toHaveCount(0);
  await expect(sheet.getByRole("region", { name: "Overflow" })).toHaveCount(0);
  await expect(sheet.getByRole("region", { name: "Target" })).toBeVisible();
  await page.keyboard.press("Escape");

  await setSavings(page, false);
  await page.goto("/budget");
  await expect(page.getByTestId("buckets").getByRole("button", { name: `${NAME} details` })).toBeVisible();
});
