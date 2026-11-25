import { test, type Page } from "@playwright/test";

/** Visual review captures (not assertions). Saved under test-results/screens/<project>/. */
async function shoot(page: Page, name: string, project: string) {
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(700);
  const base = `test-results/screens/${project}/${name}`;
  await page.screenshot({ path: `${base}.png` });
  await page.mouse.wheel(0, 900);
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${base}-scrolled.png` });
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("hb_install_hint_dismissed", "1"));
});

for (const scheme of ["light", "dark"] as const) {
  test(`screens ${scheme}`, async ({ page }, info) => {
    test.setTimeout(300_000);
    await page.emulateMedia({ colorScheme: scheme });
    const p = info.project.name;
    for (const path of ["budget", "transactions", "accounts", "plan", "wealth", "health"]) {
      await page.goto(`/${path}`);
      await shoot(page, `${path}-${scheme}`, p);
    }
    for (const [name, label] of [
      ["wealth-brokerage", "Litware Brokerage"],
      ["wealth-home", "Home"],
      ["wealth-mortgage", "Mortgage"],
    ] as const) {
      await page.goto("/wealth");
      await page.locator('a[href^="/wealth/"]').filter({ has: page.locator("span", { hasText: new RegExp(`^${label}$`) }) }).filter({ visible: true }).first().click();
      await page.waitForURL(/\/wealth\/[0-9a-f-]{36}/);
      await shoot(page, `${name}-${scheme}`, p);
    }
    await page.goto("/accounts");
    await page.locator('a[href^="/accounts/"]').filter({ has: page.locator("span", { hasText: /^Checking$/ }) }).filter({ visible: true }).first().click();
    await page.waitForURL(/\/accounts\/[0-9a-f-]{36}/);
    await shoot(page, `account-checking-${scheme}`, p);
  });
}
