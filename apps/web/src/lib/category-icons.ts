/**
 * Category icon + name helpers (pure, no React). Categories store a lucide key in `icon`; when it's null
 * (or a key we don't ship), the name's keywords pick one (`suggestCategoryIcon`), else a plain dot.
 * Names are shown without the emoji YNAB kept in them.
 */
import { DEFAULT_CATEGORY_ICON, stripEmoji, suggestCategoryIcon } from "@homebase/shared";

/** Category name as shown: leading/trailing emoji removed (falls back to the raw name if that empties it). */
export function categoryLabel(name: string | null | undefined): string {
  if (!name) return "";
  return stripEmoji(name) || name;
}

/** The icon key to draw: the stored one if we ship it, else a suggestion from the name, else the default. */
export function iconKeyFor(icon: string | null | undefined, name: string, available: (key: string) => boolean): string {
  if (icon && available(icon)) return icon;
  const s = suggestCategoryIcon(name);
  return available(s) ? s : DEFAULT_CATEGORY_ICON;
}

/** Extra search words for the icon picker (the key's own words always match). */
export const ICON_SYNONYMS: Record<string, string> = {
  house: "home mortgage rent housing",
  "house-plus": "extra principal home",
  "shopping-basket": "groceries food supermarket",
  "shopping-cart": "groceries store",
  "shopping-bag": "shopping clothes amazon",
  warehouse: "costco bulk",
  utensils: "restaurants eating out dining",
  "utensils-crossed": "restaurants dining",
  coffee: "cafe starbucks",
  zap: "electric electricity power",
  droplet: "water utility",
  flame: "gas heating hearth",
  wifi: "internet broadband",
  smartphone: "phone cell mobile",
  tv: "streaming netflix cable",
  clapperboard: "movies entertainment",
  music: "spotify songs",
  car: "auto vehicle",
  fuel: "gas petrol",
  "shield-check": "insurance",
  shield: "insurance protection",
  "heart-pulse": "health medical",
  stethoscope: "doctor medical health",
  pill: "pharmacy medicine prescriptions",
  "paw-print": "pets dog cat vet",
  baby: "kids children daycare",
  "graduation-cap": "school tuition education student loan",
  church: "tithe giving church offering",
  "hand-heart": "giving charity donation",
  gift: "gifts birthday christmas",
  wallet: "spending money fun money allowance",
  "piggy-bank": "savings retirement",
  landmark: "bank savings loan debt",
  vault: "savings emergency",
  siren: "emergency fund",
  receipt: "taxes bills",
  "receipt-text": "bills invoice",
  plane: "travel vacation flights",
  luggage: "travel trips",
  hotel: "travel lodging",
  bitcoin: "crypto",
  shirt: "clothing clothes",
  scissors: "haircut beauty salon",
  dumbbell: "gym fitness",
  "book-open": "books kindle reading",
  repeat: "subscriptions recurring",
  cloud: "icloud storage backups",
  bot: "ai claude chatgpt",
  hammer: "projects repairs home improvement",
  wrench: "maintenance repairs",
  "trash-2": "trash garbage",
  "credit-card": "card payment credit",
  "circle-dot": "default other",
  shapes: "misc miscellaneous other stuff",
  heart: "dates romance",
  briefcase: "work business",
};
