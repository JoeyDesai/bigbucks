import { expect, test } from "@playwright/test";

/**
 * Password flow. Needs a dev server started WITHOUT HOMEBASE_DEV_USER and with HOMEBASE_DEV_PASSWORD=demo-pass-1
 * (test-only value) against the demo DB, e.g. the `homebase-web-login` launch config:
 *   HOMEBASE_DEV_PASSWORD=demo-pass-1 pnpm dev -p 3101
 * Skips itself when the dev bypass is active.
 */
test.describe.configure({ mode: "serial" });

test("password sign-in: wrong password counts down and keeps the username, right one signs in", async ({ page, context }, info) => {
  test.skip(info.project.name !== "iphone-15", "stateful lockout; run once");
  await page.goto("/plan");
  test.skip(!page.url().includes("/login"), "dev bypass active");

  await page.getByLabel("Username").fill("Sam");
  await page.getByLabel("Password").fill("not-it-1");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("status")).toContainText("Wrong username or password.");
  await expect(page.getByLabel("Username")).toHaveValue("Sam");
  await page.screenshot({ path: "test-results/screens/iphone-15/login-error.png" });

  await page.getByLabel("Password").fill("demo-pass-1");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/plan/);
  const cookie = (await context.cookies()).find((c) => c.name === "hb_session");
  expect(cookie?.httpOnly).toBe(true);
  expect(cookie?.sameSite).toBe("Lax");

  // Member cannot see admin sections.
  const res = await page.goto("/settings/connections");
  expect(res?.status()).toBe(404);
});

test("robots.txt and noindex header", async ({ request }) => {
  expect(await (await request.get("/robots.txt")).text()).toContain("Disallow: /");
  expect((await request.get("/login")).headers()["x-robots-tag"]).toContain("noindex");
});
