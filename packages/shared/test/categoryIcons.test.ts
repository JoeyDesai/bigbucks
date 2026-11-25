import { describe, expect, it } from "vitest";
import {
  DEFAULT_CATEGORY_ICON,
  SUGGESTED_CATEGORY_ICONS,
  USER_ACCENTS,
  isIconKey,
  isAccentValue,
  isUserAccent,
  normalizeCategoryName,
  stripEmoji,
  suggestCategoryIcon,
} from "../src";

describe("stripEmoji", () => {
  it("removes leading and trailing emoji", () => {
    expect(stripEmoji("🏠 Mortgage")).toBe("Mortgage");
    expect(stripEmoji("Mortgage 🏠")).toBe("Mortgage");
    expect(stripEmoji("💰Savings")).toBe("Savings");
    expect(stripEmoji("  🛒  Groceries  ")).toBe("Groceries");
  });
  it("handles variation selectors, skin tones, ZWJ sequences, flags and keycaps", () => {
    expect(stripEmoji("❤️ Dates")).toBe("Dates");
    expect(stripEmoji("☁︎ Cloud")).toBe("Cloud");
    expect(stripEmoji("👨‍👩‍👧 Kids")).toBe("Kids");
    expect(stripEmoji("👍🏽 Approved")).toBe("Approved");
    expect(stripEmoji("🇯🇵 Tokyo")).toBe("Tokyo");
    expect(stripEmoji("1️⃣ First")).toBe("First");
    expect(stripEmoji("🏳️‍🌈🎉 Party 🎉")).toBe("Party");
  });
  it("keeps inner emoji, plain digits and punctuation", () => {
    expect(stripEmoji("Alex's 🎮 Games")).toBe("Alex's 🎮 Games");
    expect(stripEmoji("401k")).toBe("401k");
    expect(stripEmoji("#1 Priority")).toBe("#1 Priority");
    expect(stripEmoji("Rent")).toBe("Rent");
  });
  it("returns empty for emoji-only names", () => {
    expect(stripEmoji("🎉")).toBe("");
    expect(stripEmoji("  ")).toBe("");
  });
});

describe("normalizeCategoryName", () => {
  it("strips emoji, lowercases and collapses spaces", () => {
    expect(normalizeCategoryName("🏠  Extra   House Payments ")).toBe("extra house payments");
    expect(normalizeCategoryName("Alex’s Retirement")).toBe("alex's retirement");
  });
});

describe("suggestCategoryIcon", () => {
  const cases: Array<[string, string]> = [
    ["🏠 Mortgage", "house"],
    ["Rent", "house"],
    ["House Costs", "house"],
    ["Internet", "wifi"],
    ["WiFi", "wifi"],
    ["Electricity", "zap"],
    ["Power Bill", "zap"],
    ["Water", "droplet"],
    ["Trash", "trash-2"],
    ["Phone", "smartphone"],
    ["Auto insurance", "shield-check"],
    ["Car Insurance", "shield-check"],
    ["Health Insurance", "heart-pulse"],
    ["Insurance", "shield-check"],
    ["Music", "music"],
    ["Spotify", "music"],
    ["Netflix", "tv"],
    ["Streaming", "tv"],
    ["🛒 Groceries", "shopping-basket"],
    ["Gas", "fuel"],
    ["Fuel", "fuel"],
    ["Car Expenses", "car"],
    ["Car Maintenance", "car"],
    ["Pets", "paw-print"],
    ["Medical Expenses", "stethoscope"],
    ["Doctor", "stethoscope"],
    ["Eating Out", "utensils"],
    ["Restaurants", "utensils"],
    ["Dates", "heart"],
    ["Date Night", "heart"],
    ["Entertainment", "clapperboard"],
    ["Donations", "church"],
    ["Church", "church"],
    ["Giving", "church"],
    ["Gifts", "gift"],
    ["Alex's Spending Money", "wallet"],
    ["Sam's Spending Money", "wallet"],
    ["Retirement", "piggy-bank"],
    ["401k", "piggy-bank"],
    ["401(k) match", "piggy-bank"],
    ["💰 Savings", "landmark"],
    ["Emergency Fund", "siren"],
    ["Taxes", "receipt"],
    ["House Projects", "hammer"],
    ["Extra House Payments", "house-plus"],
    ["Travel", "plane"],
    ["Vacation", "plane"],
    ["Bitcoin", "bitcoin"],
    ["Crypto", "bitcoin"],
    ["Subscriptions", "repeat"],
    ["YNAB subscription", "repeat"],
    ["Kids", "baby"],
    ["Baby", "baby"],
    ["School loan", "graduation-cap"],
    ["Education", "graduation-cap"],
    ["ChatGPT", "bot"],
    ["Apple Storage", "cloud"],
    ["iCloud", "cloud"],
    ["Clothing", "shirt"],
    ["Misc", "shapes"],
  ];
  it.each(cases)("%s → %s", (name, icon) => {
    expect(suggestCategoryIcon(name)).toBe(icon);
  });
  it("falls back to circle-dot", () => {
    expect(suggestCategoryIcon("Zzyzx")).toBe(DEFAULT_CATEGORY_ICON);
    expect(suggestCategoryIcon("🎉")).toBe("circle-dot");
    expect(suggestCategoryIcon("")).toBe("circle-dot");
  });
  it("only returns kebab-case keys", () => {
    for (const icon of SUGGESTED_CATEGORY_ICONS) expect(isIconKey(icon)).toBe(true);
    expect(isIconKey("PiggyBank")).toBe(false);
    expect(isIconKey("piggy bank")).toBe(false);
  });
});

describe("accents", () => {
  it("validates named accents", () => {
    expect(USER_ACCENTS).toEqual(["gold", "blue", "pink", "green", "purple", "orange", "teal"]);
    expect(isUserAccent("pink")).toBe(true);
    expect(isUserAccent("red")).toBe(false);
    expect(isUserAccent(null)).toBe(false);
    expect(isAccentValue("#3d6bff")).toBe(true);
    expect(isAccentValue("#3D6BFF")).toBe(false);
    expect(isAccentValue("#3d6bf")).toBe(false);
    expect(isAccentValue("teal")).toBe(true);
  });
});
