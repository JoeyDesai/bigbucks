/** Settings sections (spec §12.6). `admin` sections are hidden from and 404 for members. */
export interface SettingsSection {
  slug: string;
  title: string;
  blurb: string;
  admin?: boolean;
  /** What the page will hold once wired (shown on the stub). */
  planned: string[];
}

export const SETTINGS_SECTIONS: SettingsSection[] = [
  { slug: "connections", title: "Connections", admin: true, blurb: "Bank, broker and crypto connections, keys and sync health.", planned: ["Provider, status and last success", "SimpleFIN requests used today", "Test, rotate key, reconnect instructions", "Secrets shown as last 4 characters only"] },
  { slug: "accounts", title: "Accounts", blurb: "Names, nicknames, due days, contributions, close.", planned: ["Edit and close accounts", "New-account inbox is on Activity"] },
  { slug: "categories", title: "Buckets", blurb: "Add, rename, reorder, hide and merge buckets.", planned: ["Create, reorder, hide", "Merge (recategorizes history)"] },
  { slug: "targets", title: "Targets", blurb: "Every category target in one list, with an editor.", planned: ["List targets", "Edit from this month on"] },
  { slug: "rules", title: "Rules", blurb: "Categorization rules with a test against history.", planned: ["List, create, edit", "Test against history (N matches)", "Hit counts, enable/disable"] },
  { slug: "payees", title: "Payees", blurb: "Rename, merge, default category, merchant profile.", planned: ["Rename and merge", "Default category", "Merchant profile from web lookup"] },
  { slug: "memory", title: "Household memory", blurb: "Plain facts Ask can use, like “Paychecks land on the 25th”.", planned: ["Editable list of facts", "Who added each one"] },
  { slug: "notifications", title: "Notifications", blurb: "Push alerts, one switch per alert type.", planned: ["Connection needs reconnecting", "Category overspent", "Large transaction over $500", "Card payment due in 3 days", "Weekly digest"] },
  { slug: "imports", title: "Imports", blurb: "YNAB, CSV/OFX, River CSV, Fidelity positions.", planned: ["YNAB history import", "CSV / OFX", "River activity CSV", "Fidelity positions CSV"] },
  { slug: "ai", title: "AI", admin: true, blurb: "Models, monthly cap, approval thresholds, usage.", planned: ["Model IDs", "Monthly cap (default $8)", "Approval thresholds and always-review categories", "Web lookup on/off", "Usage, cost and accuracy charts"] },
  { slug: "users", title: "Users & passwords", admin: true, blurb: "Who can sign in, usernames and passwords.", planned: ["Everyone in the household", "Username and password per person", "Set or change a password", "Sign out other sessions"] },
  { slug: "backups", title: "Backups", admin: true, blurb: "Nightly dumps, last run, download the latest.", planned: ["Last run and size", "Download latest dump", "Restore instructions"] },
];

export const ADMIN_SLUGS = SETTINGS_SECTIONS.filter((s) => s.admin).map((s) => s.slug);
