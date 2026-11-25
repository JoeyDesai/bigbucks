/**
 * Category icons and per-user accents for the Big Bucks UI.
 *
 * Categories carry a lucide-react icon key (kebab-case, e.g. "piggy-bank") instead of the emoji YNAB keeps
 * in the name. Importers strip the emoji with `stripEmoji` and pick an icon with `suggestCategoryIcon`.
 */

export const USER_ACCENTS = ["gold", "blue", "pink", "green", "purple", "orange", "teal"] as const;
export type UserAccent = (typeof USER_ACCENTS)[number];
export const DEFAULT_USER_ACCENT: UserAccent = "gold";

export function isUserAccent(value: unknown): value is UserAccent {
  return typeof value === "string" && (USER_ACCENTS as readonly string[]).includes(value);
}

/** A custom accent picked with a color input: "#rrggbb" (lowercase). */
export type CustomAccent = `#${string}`;
export const CUSTOM_ACCENT_RE = /^#[0-9a-f]{6}$/;
export function isCustomAccent(value: unknown): value is CustomAccent {
  return typeof value === "string" && CUSTOM_ACCENT_RE.test(value);
}
/** Anything users.accent may hold: a named accent or a custom "#rrggbb". */
export type AccentValue = UserAccent | CustomAccent;
export function isAccentValue(value: unknown): value is AccentValue {
  return isUserAccent(value) || isCustomAccent(value);
}

/** Fallback icon when no keyword matches. */
export const DEFAULT_CATEGORY_ICON = "circle-dot";

/** A lucide key: lowercase letters/digits in kebab-case. */
export const ICON_KEY_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isIconKey(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 && ICON_KEY_RE.test(value);
}

// One emoji "unit": a pictographic char (or keycap base / regional indicator) plus any modifiers,
// variation selectors, tag characters and ZWJ continuations. Also plain variation selectors / ZWJ left over.
const EMOJI_PIECE =
  "(?:[0-9#*]\\uFE0F?\\u20E3" +
  "|[\\p{Extended_Pictographic}\\p{Regional_Indicator}\\u{1F3FB}-\\u{1F3FF}\\uFE0E\\uFE0F\\u200D\\u20E3\\u{E0020}-\\u{E007F}])";
const LEADING = new RegExp(`^(?:${EMOJI_PIECE}|\\s)+`, "u");
const TRAILING = new RegExp(`(?:${EMOJI_PIECE}|\\s)+$`, "u");

/**
 * Removes leading and trailing emoji (with skin tones, variation selectors, ZWJ sequences, flags and keycaps)
 * and surrounding whitespace. Emoji in the middle of a name are kept. A name that is only emoji becomes "".
 */
export function stripEmoji(name: string): string {
  return name.replace(LEADING, "").replace(TRAILING, "").trim();
}

/** Name used to match categories across sources: emoji stripped, lowercased, whitespace collapsed. */
export function normalizeCategoryName(name: string): string {
  return stripEmoji(name).normalize("NFKC").toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, " ").trim();
}

/** Ordered: the first rule whose pattern matches the normalized name wins, so specific rules come first. */
const ICON_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  // Insurance before the things it insures.
  [/\b(auto|car|vehicle)\s+insurance\b|\binsurance\b.*\b(auto|car)\b/, "shield-check"],
  [/\b(health|medical|dental|vision|life)\s+insurance\b/, "heart-pulse"],
  [/\b(home|homeowners?|renters?|house)\s+insurance\b/, "shield"],
  [/\binsurance\b/, "shield-check"],
  [/\b(car|auto|vehicles?)\b/, "car"],
  // Education / loans before generic "loan" or "house".
  [/\bstudent\b|\btuition\b|\beducation\b|\bschool\b|\bcollege\b|\bcourses?\b/, "graduation-cap"],
  // Projects / repairs before house.
  [/\bprojects?\b|\brepairs?\b|\brenovation\b|\bhome improvement\b|\bmaintenance\b|\btools?\b/, "hammer"],
  [/\bextra\b.*\b(house|home|mortgage|principal)\b/, "house-plus"],
  [/\bmortgage\b|\brent\b|\bhouse\b|\bhome\b|\bhousing\b|\bhoa\b|\bproperty tax\b/, "house"],
  [/\binternet\b|\bwi-?fi\b|\bbroadband\b|\bfiber\b/, "wifi"],
  [/\belectric(ity)?\b|\bpower\b|\benergy\b/, "zap"],
  [/\bwater\b|\bsewer\b/, "droplet"],
  [/\btrash\b|\bgarbage\b|\brecycling\b|\bwaste\b/, "trash-2"],
  [/\bnatural gas\b|\bheating\b|\bpropane\b/, "flame"],
  [/\bphones?\b|\bcell\b|\bmobile\b|\bwireless\b/, "smartphone"],
  [/\bmusic\b|\bspotify\b|\bapple music\b|\bpandora\b|\btidal\b/, "music"],
  [/\bstreaming\b|\bnetflix\b|\bhulu\b|\bdisney\b|\bhbo\b|\byoutube\b|\bcable\b|\btv\b|\bparamount\b|\bpeacock\b/, "tv"],
  [/\bcloud\b|\bicloud\b|\bstorage\b|\bdropbox\b|\bgoogle one\b|\bbackups?\b/, "cloud"],
  [/\bai\b|\bclaude\b|\bchatgpt\b|\bopenai\b|\banthropic\b/, "bot"],
  [/\bsubscriptions?\b|\bmemberships?\b|\brecurring\b/, "repeat"],
  [/\bgrocer(y|ies)\b|\bfood\b|\bsupermarket\b/, "shopping-basket"],
  [/\bcostco\b|\bwarehouse\b|\bbulk\b|\bsam'?s club\b/, "warehouse"],
  [/\bgas\b|\bfuel\b|\bgasoline\b|\bpetrol\b/, "fuel"],
  [/\bparking\b|\btolls?\b|\bregistration\b/, "car"],
  [/\bpets?\b|\bdogs?\b|\bcats?\b|\bvet\b|\bveterinary\b/, "paw-print"],
  [/\bmedical\b|\bdoctors?\b|\bhealth\b|\bpharmacy\b|\bprescriptions?\b|\bdental\b|\bdentist\b|\bhospital\b|\bcopay\b|\bhsa\b/, "stethoscope"],
  [/\beating out\b|\brestaurants?\b|\bdining\b|\btake ?out\b|\bdelivery\b|\bfast food\b|\blunch\b|\bcoffee\b/, "utensils"],
  [/\bdates?\b|\bdate night\b|\bromance\b|\banniversary\b/, "heart"],
  [/\bentertainment\b|\bmovies?\b|\bconcerts?\b|\bgames?\b|\bgaming\b|\bhobbies\b/, "clapperboard"],
  [/\btithes?\b|\bchurch\b|\bgiving\b|\bdonations?\b|\bcharity\b|\boffering\b/, "church"],
  [/\bgifts?\b|\bbirthdays?\b|\bchristmas\b|\bholidays?\b/, "gift"],
  [/\bspending money\b|\bfun money\b|\ballowance\b|\bpocket money\b|\bblow money\b|\bwallet\b/, "wallet"],
  [/\bretirement\b|\b401\s?\(?k\b|\bira\b|\broth\b|\b403\s?\(?b\b|\bpension\b/, "piggy-bank"],
  [/\bemergency\b|\brainy day\b/, "siren"],
  [/\btax(es)?\b|\birs\b|\baccountant\b|\bcpa\b/, "receipt"],
  [/\btravel\b|\bvacations?\b|\btrips?\b|\bflights?\b|\bhotels?\b|\bholiday travel\b/, "plane"],
  [/\bcrypto\b|\bbitcoin\b|\bbtc\b|\bethereum\b/, "bitcoin"],
  [/\bkids?\b|\bbaby\b|\bchild(ren)?\b|\bchildcare\b|\bdaycare\b|\bdiapers?\b/, "baby"],
  [/\bclothing\b|\bclothes\b|\bapparel\b|\bshoes\b/, "shirt"],
  [/\bsavings?\b|\bsave\b|\binvest(ing|ments?)?\b|\bsinking\b/, "landmark"],
  [/\bloans?\b|\bdebt\b/, "landmark"],
  [/\bmisc(ellaneous)?\b|\bother\b|\bstuff\b/, "shapes"],
  [/\bhaircuts?\b|\bbeauty\b|\bpersonal care\b|\bsalon\b/, "scissors"],
  [/\bgym\b|\bfitness\b|\bworkout\b/, "dumbbell"],
  [/\bbooks?\b|\bkindle\b|\baudible\b/, "book-open"],
  [/\bshopping\b|\bamazon\b/, "shopping-bag"],
];

/** Picks a lucide icon key for a category name from keywords; "circle-dot" when nothing matches. */
export function suggestCategoryIcon(name: string): string {
  const n = normalizeCategoryName(name);
  if (!n) return DEFAULT_CATEGORY_ICON;
  for (const [re, icon] of ICON_RULES) if (re.test(n)) return icon;
  return DEFAULT_CATEGORY_ICON;
}

/** Every icon key `suggestCategoryIcon` can return (for UI allow-lists and tests). */
export const SUGGESTED_CATEGORY_ICONS: readonly string[] = [...new Set([...ICON_RULES.map(([, icon]) => icon), DEFAULT_CATEGORY_ICON])];
