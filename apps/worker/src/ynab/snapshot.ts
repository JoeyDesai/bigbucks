/**
 * `import:ynab-snapshot`: seed the budget from a YNAB *web UI* snapshot (one month of the Plan screen:
 * groups, categories, icons, assigned / activity / available / carry-in, targets, hidden categories),
 * for when the full API import (`import:ynab`) isn't available yet.
 *
 * One transaction, idempotent (a re-run first undoes the previous snapshot's writes, then applies again):
 *  - entities + system categories; optional `onBudget` accounts are moved onto the budget (inbox accept);
 *  - groups in file order (the system "Credit Card Payments" group is never created as a normal group);
 *  - categories matched by (group, normalized name), else a unique normalized name across groups;
 *    names stored without emoji, icon from the file (fallback `suggestCategoryIcon`), `hidden` list hidden;
 *  - targets: one row per category at effective_from = the snapshot month (a removed tombstone when the
 *    file has none but an older live target exists);
 *  - month_assignments for the snapshot month = `assigned`;
 *  - **opening balances**: for each category with carryIn ≠ 0, the PREVIOUS month's assignment = carryIn,
 *    with a month note "Opening balances imported from YNAB" on that month, so Available matches YNAB
 *    before this month's activity;
 *  - card payment categories are linked to on-budget cards via `cards` (category name → account id),
 *    or matched to an existing linked payment category by name; otherwise reported as pending.
 * Everything written is recorded in settings `ynab_ui_snapshot` so `undoUiSnapshot` can remove it.
 * The full YNAB import calls `undoUiSnapshot` before writing YNAB's real history (YNAB is the source of truth).
 */
import { and, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { accounts, categories, categoryGroups, monthAssignments, monthNotes, settings, targets, type Db, type Tx } from "@homebase/db";
import { ensurePaymentCategory, getBudgetMonth, putAccountOnBudget, recompute, systemCtx } from "@homebase/core";
import { CADENCES, TARGET_TYPES, addMonths, formatMilli, isIconKey, normalizeCategoryName, suggestCategoryIcon, today as localToday, type ISODate, type Milli, type Month } from "@homebase/shared";
import { BUSINESS_ENTITY, HOUSEHOLD_ENTITY, ensureEntity } from "../ingest/accounts";
import { SETTING_KEYS, getSetting, setSetting } from "../settings";
import { ensureSystemCategories, importedName } from "./import";

export const UI_SNAPSHOT_KEY = SETTING_KEYS.ynabUiSnapshot;
export const OPENING_NOTE = "Opening balances imported from YNAB";
const CC_GROUP_NAME = "Credit Card Payments";
const CREDIT_KINDS = ["credit_card", "line_of_credit"] as const;

const MilliInt = z.number().int().safe();
const SnapshotCategory = z.object({
  name: z.string().trim().min(1).max(100),
  icon: z.string().nullish(),
  assigned: MilliInt.default(0),
  activity: MilliInt.default(0),
  available: MilliInt.default(0),
  carryIn: MilliInt.default(0),
  target: z
    .object({
      type: z.enum(TARGET_TYPES),
      amount: MilliInt,
      cadence: z.enum(CADENCES).default("monthly"),
      day: z.number().int().min(0).max(31).nullish(),
    })
    .nullish(),
});
export const UiSnapshotSchema = z.object({
  month: z.string().regex(/^\d{4}-\d{2}-01$/, "month must be YYYY-MM-01"),
  groups: z.array(z.object({ name: z.string().trim().min(1).max(100), system: z.boolean().default(false), categories: z.array(SnapshotCategory) })),
  hidden: z.array(z.object({ group: z.string().trim().min(1), name: z.string().trim().min(1).max(100), icon: z.string().nullish() })).default([]),
  summary: z.record(z.string(), z.number()).optional(),
});
export type UiSnapshot = z.infer<typeof UiSnapshotSchema>;

/** settings[ynab_ui_snapshot]: everything the snapshot import wrote, so it can be undone. */
export interface UiSnapshotSetting {
  file: string;
  month: Month;
  /** The month holding the opening-balance assignments (month − 1). */
  openingMonth: Month;
  /** Every category the snapshot created or updated. */
  categoryIds: string[];
  /** Categories with an assignment written in `month`. */
  assignedCategoryIds: string[];
  /** Categories with an opening-balance assignment written in `openingMonth`. */
  openingCategoryIds: string[];
  /** Categories with a target row written at effective_from = `month`. */
  targetCategoryIds: string[];
  importedAt: string;
}

export interface UiSnapshotOptions {
  /** Path shown in the summary and stored in the setting. */
  file: string;
  /** Overrides the file's month. */
  month?: Month;
  /** Card payment category name (as in the file) → on-budget credit account id. */
  cards?: Record<string, string>;
  /** Accounts to move onto the budget first (inbox accept). */
  onBudget?: string[];
  dryRun?: boolean;
  /** Apply even though a full YNAB import already exists. */
  force?: boolean;
  now?: Date;
  today?: ISODate;
}

export interface UiSnapshotMismatch {
  group: string;
  category: string;
  field: "carryIn" | "assigned" | "missing";
  file: Milli;
  hearth: Milli | null;
}

export interface UiSnapshotSummary {
  file: string;
  month: Month;
  openingMonth: Month;
  dryRun: boolean;
  undidPrevious: boolean;
  groups: { created: number; updated: number };
  categories: { created: number; updated: number; hidden: number };
  targets: { set: number; removed: number };
  assigned: { count: number; total: Milli };
  carry: { count: number; total: Milli };
  cards: { linked: { category: string; accountId: string }[]; pending: string[] };
  onBudget: string[];
  warnings: string[];
  /** After recompute: Hearth's carry-in / assigned for the month vs the file. */
  verify: { readyToAssign: { file: Milli | null; hearth: Milli }; mismatches: UiSnapshotMismatch[] };
}

class DryRunRollback extends Error {
  constructor(readonly summary: UiSnapshotSummary) {
    super("dry run");
  }
}

export function parseUiSnapshot(raw: unknown): UiSnapshot {
  return UiSnapshotSchema.parse(raw);
}

/** Import a YNAB UI snapshot (see the module comment). `dryRun` does everything, prints, and rolls back. */
export async function importUiSnapshot(db: Db, raw: unknown, o: UiSnapshotOptions): Promise<UiSnapshotSummary> {
  const snap = parseUiSnapshot(raw);
  try {
    return await db.transaction(async (tx) => {
      const s = await applySnapshot(tx, snap, o);
      if (o.dryRun) throw new DryRunRollback(s);
      return s;
    });
  } catch (e) {
    if (e instanceof DryRunRollback) return e.summary;
    throw e;
  }
}

async function applySnapshot(tx: Tx, snap: UiSnapshot, o: UiSnapshotOptions): Promise<UiSnapshotSummary> {
  const now = o.now ?? new Date();
  const today = o.today ?? localToday();
  const month = (o.month ?? snap.month) as Month;
  const openingMonth = addMonths(month, -1);
  const s: UiSnapshotSummary = {
    file: o.file,
    month,
    openingMonth,
    dryRun: !!o.dryRun,
    undidPrevious: false,
    groups: { created: 0, updated: 0 },
    categories: { created: 0, updated: 0, hidden: 0 },
    targets: { set: 0, removed: 0 },
    assigned: { count: 0, total: 0n },
    carry: { count: 0, total: 0n },
    cards: { linked: [], pending: [] },
    onBudget: [],
    warnings: [],
    verify: { readyToAssign: { file: null, hearth: 0n }, mismatches: [] },
  };
  if (o.month && o.month !== snap.month) s.warnings.push(`file month ${snap.month} imported into ${month} (--month)`);

  if (!o.force && (await getSetting(tx, SETTING_KEYS.ynabImport))) {
    throw new Error("a full YNAB import (import:ynab) already exists; the snapshot would replace its numbers. Pass --force to apply anyway.");
  }
  // Idempotent: remove whatever a previous snapshot wrote, then apply this one.
  s.undidPrevious = await undoUiSnapshot(tx, { assignments: true });

  await ensureEntity(tx, HOUSEHOLD_ENTITY);
  await ensureEntity(tx, BUSINESS_ENTITY);
  await ensureSystemCategories(tx);

  const ctx = systemCtx(tx, today);
  for (const id of o.onBudget ?? []) {
    const a = await putAccountOnBudget(ctx, id);
    s.onBudget.push(a.name);
  }

  const setting: UiSnapshotSetting = { file: o.file, month, openingMonth, categoryIds: [], assignedCategoryIds: [], openingCategoryIds: [], targetCategoryIds: [], importedAt: now.toISOString() };
  const touched = new Set<string>();
  const hiddenKeys = new Set(snap.hidden.map((h) => `${normalizeCategoryName(h.group)}\u0000${normalizeCategoryName(h.name)}`));

  // ── groups ────────────────────────────────────────────────────────────────────────────────────
  const groupRows = await tx.select().from(categoryGroups).where(and(isNull(categoryGroups.deletedAt), eq(categoryGroups.isSystem, false)));
  const groupByKey = new Map(groupRows.map((g) => [normalizeCategoryName(g.name), g]));
  let groupSort = 0;
  const ensureGroup = async (name: string): Promise<string> => {
    const key = normalizeCategoryName(name);
    const sort = ++groupSort;
    const found = groupByKey.get(key);
    if (found) {
      await tx.update(categoryGroups).set({ name: importedName(name), sort, hidden: false, updatedAt: now }).where(eq(categoryGroups.id, found.id));
      s.groups.updated++;
      return found.id;
    }
    const [g] = await tx.insert(categoryGroups).values({ name: importedName(name), sort }).returning();
    groupByKey.set(key, g!);
    s.groups.created++;
    return g!.id;
  };
  const isCcGroup = (g: { name: string; system: boolean }) => g.system || normalizeCategoryName(g.name) === normalizeCategoryName(CC_GROUP_NAME);

  // ── categories ────────────────────────────────────────────────────────────────────────────────
  const normalCats = (await tx.select().from(categories).where(and(isNull(categories.deletedAt), eq(categories.kind, "normal")))).map((c) => ({ ...c, key: normalizeCategoryName(c.name) }));
  const used = new Set<string>();
  const ensureCategory = async (groupId: string, groupName: string, name: string, icon: string | null | undefined, sort: number, hidden: boolean): Promise<string> => {
    const key = normalizeCategoryName(name);
    let found = normalCats.find((c) => !used.has(c.id) && c.groupId === groupId && c.key === key);
    if (!found) {
      const across = normalCats.filter((c) => !used.has(c.id) && c.key === key);
      if (across.length === 1) found = across[0];
      else if (across.length > 1) s.warnings.push(`"${name}" matches ${across.length} categories in other groups; created a new one in ${groupName}`);
    }
    const values = { groupId, name: importedName(name), icon: icon && isIconKey(icon) ? icon : suggestCategoryIcon(name), sort, hidden };
    if (icon && !isIconKey(icon)) s.warnings.push(`"${name}": icon "${icon}" is not a lucide key; using ${values.icon}`);
    let id: string;
    if (found) {
      await tx.update(categories).set({ ...values, updatedAt: now }).where(eq(categories.id, found.id));
      id = found.id;
      s.categories.updated++;
    } else {
      const [c] = await tx.insert(categories).values(values).returning({ id: categories.id });
      id = c!.id;
      s.categories.created++;
    }
    used.add(id);
    touched.add(id);
    if (hidden) s.categories.hidden++;
    return id;
  };

  // ── card payment categories ─────────────────────────────────────────────────────────────────
  const cards = Object.entries(o.cards ?? {});
  for (const [name] of cards) {
    const listed = snap.groups.some((g) => isCcGroup(g) && g.categories.some((c) => normalizeCategoryName(c.name) === normalizeCategoryName(name)));
    if (!listed) throw new Error(`--card "${name}": no such category under ${CC_GROUP_NAME} in the file`);
  }
  const resolvePaymentCategory = async (name: string): Promise<string | null> => {
    const key = normalizeCategoryName(name);
    const given = cards.find(([n]) => normalizeCategoryName(n) === key);
    if (given) {
      const [a] = await tx.select().from(accounts).where(eq(accounts.id, given[1]));
      if (!a || a.deletedAt) throw new Error(`--card "${name}": account ${given[1]} not found`);
      if (!(CREDIT_KINDS as readonly string[]).includes(a.kind)) throw new Error(`--card "${name}": account "${a.name}" is a ${a.kind}, not a credit card`);
      if (!a.onBudget) throw new Error(`--card "${name}": account "${a.name}" is off budget (add --on-budget ${a.id})`);
      const id = await ensurePaymentCategory(tx, a);
      s.cards.linked.push({ category: name, accountId: a.id });
      return id;
    }
    // An already-linked payment category whose name (or card's name) matches.
    const rows = await tx
      .select({ id: categories.id, name: categories.name, accountId: accounts.id, accountName: accounts.name })
      .from(categories)
      .innerJoin(accounts, eq(accounts.id, categories.linkedAccountId))
      .where(and(eq(categories.kind, "cc_payment"), isNull(categories.deletedAt), eq(accounts.onBudget, true), isNull(accounts.deletedAt)));
    const hit = rows.filter((r) => normalizeCategoryName(r.name) === key || normalizeCategoryName(r.accountName) === key);
    if (hit.length === 1) {
      s.cards.linked.push({ category: name, accountId: hit[0]!.accountId });
      return hit[0]!.id;
    }
    s.cards.pending.push(name);
    return null;
  };

  // ── walk the file ───────────────────────────────────────────────────────────────────────────
  const assignedRows: { categoryId: string; amount: bigint }[] = [];
  const openingRows: { categoryId: string; amount: bigint }[] = [];
  type FileCat = UiSnapshot["groups"][number]["categories"][number];
  const fileCats: { group: string; c: FileCat; id: string | null }[] = [];
  const takeNumbers = (id: string, c: FileCat) => {
    if (c.assigned !== 0) assignedRows.push({ categoryId: id, amount: BigInt(c.assigned) });
    if (c.carryIn !== 0) {
      openingRows.push({ categoryId: id, amount: BigInt(c.carryIn) });
      if (c.carryIn < 0) s.warnings.push(`"${c.name}": negative carry-in can't be reproduced by an opening assignment (overspending resets next month)`);
    }
  };
  const groupIdByKey = new Map<string, { id: string; name: string }>();

  for (const g of snap.groups) {
    if (isCcGroup(g)) {
      for (const c of g.categories) {
        const id = await resolvePaymentCategory(c.name);
        fileCats.push({ group: g.name, c, id });
        if (!id) continue;
        touched.add(id);
        const [cur] = await tx.select({ icon: categories.icon }).from(categories).where(eq(categories.id, id));
        const icon = c.icon && isIconKey(c.icon) ? c.icon : (cur?.icon ?? "credit-card");
        await tx.update(categories).set({ icon, updatedAt: now }).where(eq(categories.id, id));
        takeNumbers(id, c);
        await writeTarget(id, c);
      }
      continue;
    }
    const groupId = await ensureGroup(g.name);
    groupIdByKey.set(normalizeCategoryName(g.name), { id: groupId, name: g.name });
    for (const [i, c] of g.categories.entries()) {
      const hidden = hiddenKeys.has(`${normalizeCategoryName(g.name)}\u0000${normalizeCategoryName(c.name)}`);
      const id = await ensureCategory(groupId, g.name, c.name, c.icon, i, hidden);
      fileCats.push({ group: g.name, c, id });
      takeNumbers(id, c);
      await writeTarget(id, c);
    }
  }
  // Hidden categories not listed in the visible groups: no numbers, just identity + icon.
  const visibleKeys = new Set(snap.groups.flatMap((g) => g.categories.map((c) => `${normalizeCategoryName(g.name)}\u0000${normalizeCategoryName(c.name)}`)));
  for (const h of snap.hidden) {
    const gk = normalizeCategoryName(h.group);
    if (visibleKeys.has(`${gk}\u0000${normalizeCategoryName(h.name)}`)) continue;
    if (gk === normalizeCategoryName(CC_GROUP_NAME)) {
      s.warnings.push(`hidden card payment category "${h.name}" skipped`);
      continue;
    }
    let g = groupIdByKey.get(gk);
    if (!g) {
      g = { id: await ensureGroup(h.group), name: h.group };
      groupIdByKey.set(gk, g);
    }
    const [m] = await tx.select({ s: sql<number | null>`max(${categories.sort})` }).from(categories).where(eq(categories.groupId, g.id));
    await ensureCategory(g.id, g.name, h.name, h.icon, (m?.s ?? -1) + 1, true);
  }

  async function writeTarget(categoryId: string, c: FileCat): Promise<void> {
    if (c.target) {
      const values = { type: c.target.type, amountMilli: BigInt(c.target.amount), cadence: c.target.cadence, cadenceEvery: 1, day: c.target.day ?? null, createdMonth: month, removed: false, targetDate: null, snoozedMonth: null };
      await tx.insert(targets).values({ categoryId, effectiveFrom: month, ...values }).onConflictDoUpdate({ target: [targets.categoryId, targets.effectiveFrom], set: { ...values, updatedAt: now } });
      setting.targetCategoryIds.push(categoryId);
      s.targets.set++;
      return;
    }
    // No target in YNAB: end an older live target from this month on.
    const [live] = await tx.select({ removed: targets.removed }).from(targets).where(and(eq(targets.categoryId, categoryId), lt(targets.effectiveFrom, month))).orderBy(sql`${targets.effectiveFrom} desc`).limit(1);
    if (live && !live.removed) {
      await tx
        .insert(targets)
        .values({ categoryId, effectiveFrom: month, type: "need_refill", createdMonth: month, removed: true })
        .onConflictDoUpdate({ target: [targets.categoryId, targets.effectiveFrom], set: { removed: true, updatedAt: now } });
      setting.targetCategoryIds.push(categoryId);
      s.targets.removed++;
    }
  }

  // ── assignments + opening balances ─────────────────────────────────────────────────────────
  const upsert = async (m: Month, rows: { categoryId: string; amount: bigint }[]) => {
    if (!rows.length) return;
    await tx
      .insert(monthAssignments)
      .values(rows.map((r) => ({ month: m, categoryId: r.categoryId, assignedMilli: r.amount })))
      .onConflictDoUpdate({ target: [monthAssignments.month, monthAssignments.categoryId], set: { assignedMilli: sql`excluded.assigned_milli`, updatedAt: now } });
  };
  await upsert(month, assignedRows);
  await upsert(openingMonth, openingRows);
  // A file category with assigned 0 must read 0 even if the DB had something for the month.
  const zeroAssigned = fileCats.filter((f) => f.id && f.c.assigned === 0).map((f) => f.id!);
  if (zeroAssigned.length) await tx.delete(monthAssignments).where(and(eq(monthAssignments.month, month), inArray(monthAssignments.categoryId, zeroAssigned)));
  s.assigned = { count: assignedRows.length, total: assignedRows.reduce((a, r) => a + r.amount, 0n) };
  s.carry = { count: openingRows.length, total: openingRows.reduce((a, r) => a + r.amount, 0n) };
  setting.assignedCategoryIds = assignedRows.map((r) => r.categoryId);
  setting.openingCategoryIds = openingRows.map((r) => r.categoryId);
  if (openingRows.length) {
    const [note] = await tx.select().from(monthNotes).where(and(eq(monthNotes.month, openingMonth), isNull(monthNotes.categoryId)));
    if (!note) await tx.insert(monthNotes).values({ month: openingMonth, categoryId: null, note: OPENING_NOTE });
    else if (!note.note.includes(OPENING_NOTE)) await tx.update(monthNotes).set({ note: `${note.note}\n${OPENING_NOTE}`, updatedAt: now }).where(eq(monthNotes.id, note.id));
  }
  if (touched.size) {
    const [earlier] = await tx
      .select({ n: sql<number>`count(distinct ${monthAssignments.categoryId})::int` })
      .from(monthAssignments)
      .where(and(lt(monthAssignments.month, openingMonth), inArray(monthAssignments.categoryId, [...touched])));
    if ((earlier?.n ?? 0) > 0) s.warnings.push(`${earlier!.n} categories have assignments before ${openingMonth}; carry-in may not match YNAB`);
  }

  setting.categoryIds = [...touched];
  await setSetting(tx, UI_SNAPSHOT_KEY, setting);

  // ── recompute + verify ──────────────────────────────────────────────────────────────────────
  await recompute(tx, { fromMonth: null, today });
  const view = await getBudgetMonth(tx, month, { today });
  const byId = new Map([...view.groups.flatMap((g) => g.categories), ...view.hidden].map((c) => [c.id, c]));
  for (const f of fileCats) {
    if (!f.id) continue;
    const c = byId.get(f.id);
    if (!c) {
      s.verify.mismatches.push({ group: f.group, category: f.c.name, field: "missing", file: BigInt(f.c.available), hearth: null });
      continue;
    }
    if (c.carryIn !== BigInt(f.c.carryIn)) s.verify.mismatches.push({ group: f.group, category: f.c.name, field: "carryIn", file: BigInt(f.c.carryIn), hearth: c.carryIn });
    if (c.assigned !== BigInt(f.c.assigned)) s.verify.mismatches.push({ group: f.group, category: f.c.name, field: "assigned", file: BigInt(f.c.assigned), hearth: c.assigned });
  }
  const rta = snap.summary?.readyToAssign;
  s.verify.readyToAssign = { file: typeof rta === "number" && Number.isSafeInteger(rta) ? BigInt(rta) : null, hearth: view.summary.readyToAssign };
  return s;
}

/**
 * Remove what the last snapshot import wrote (opening-balance assignments, the opening month note,
 * snapshot targets and, with `assignments`, the snapshot month's assignments) and delete the setting.
 * Categories and groups stay. Returns false when there was no snapshot.
 */
export async function undoUiSnapshot(tx: Tx, o: { assignments?: boolean } = {}): Promise<boolean> {
  const st = await getSetting<UiSnapshotSetting>(tx, UI_SNAPSHOT_KEY);
  if (!st) return false;
  const opening = st.openingCategoryIds ?? st.categoryIds ?? [];
  if (opening.length) await tx.delete(monthAssignments).where(and(eq(monthAssignments.month, st.openingMonth), inArray(monthAssignments.categoryId, opening)));
  if (o.assignments && st.assignedCategoryIds?.length) await tx.delete(monthAssignments).where(and(eq(monthAssignments.month, st.month), inArray(monthAssignments.categoryId, st.assignedCategoryIds)));
  const tgt = st.targetCategoryIds ?? st.categoryIds ?? [];
  if (tgt.length) await tx.delete(targets).where(and(eq(targets.effectiveFrom, st.month), inArray(targets.categoryId, tgt)));
  const [note] = await tx.select().from(monthNotes).where(and(eq(monthNotes.month, st.openingMonth), isNull(monthNotes.categoryId)));
  if (note?.note.includes(OPENING_NOTE)) {
    const rest = note.note
      .split("\n")
      .filter((l) => l.trim() !== OPENING_NOTE)
      .join("\n")
      .trim();
    if (rest) await tx.update(monthNotes).set({ note: rest, updatedAt: new Date() }).where(eq(monthNotes.id, note.id));
    else await tx.delete(monthNotes).where(eq(monthNotes.id, note.id));
  }
  await tx.delete(settings).where(eq(settings.key, UI_SNAPSHOT_KEY));
  return true;
}

// ── CLI helpers ─────────────────────────────────────────────────────────────────────────────

/** `--card "<category name>=<accountId>"` flags → map. */
export function parseCardFlags(flags: string[] = []): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of flags) {
    const i = f.lastIndexOf("=");
    if (i <= 0 || i === f.length - 1) throw new Error(`--card "${f}": expected "<category name>=<accountId>"`);
    out[f.slice(0, i).trim()] = f.slice(i + 1).trim();
  }
  return out;
}

export function formatSnapshotSummary(s: UiSnapshotSummary): string {
  const rows: [string, string][] = [
    ["Groups", `${s.groups.created} created, ${s.groups.updated} updated`],
    ["Categories", `${s.categories.created} created, ${s.categories.updated} updated, ${s.categories.hidden} hidden`],
    ["Targets", `${s.targets.set} set${s.targets.removed ? `, ${s.targets.removed} ended` : ""} (effective ${s.month})`],
    [`Assigned ${s.month}`, `${formatMilli(s.assigned.total)} across ${s.assigned.count}`],
    [`Opening carry ${s.openingMonth}`, `${formatMilli(s.carry.total)} across ${s.carry.count}`],
    ["Card payments", `${s.cards.linked.length} linked${s.cards.pending.length ? `, ${s.cards.pending.length} pending` : ""}`],
    ["Moved on budget", s.onBudget.length ? s.onBudget.join(", ") : "none"],
    ["Ready to Assign", `Hearth ${formatMilli(s.verify.readyToAssign.hearth)}${s.verify.readyToAssign.file !== null ? ` / YNAB ${formatMilli(s.verify.readyToAssign.file)}` : ""}`],
    ["Carry/assigned check", s.verify.mismatches.length ? `${s.verify.mismatches.length} differ` : "all match YNAB"],
  ];
  const w = Math.max(...rows.map(([k]) => k.length));
  const out = [`${s.dryRun ? "DRY RUN (rolled back): " : ""}YNAB UI snapshot ${s.file} → ${s.month}${s.undidPrevious ? " (replaced the previous snapshot)" : ""}`];
  for (const [k, v] of rows) out.push(`  ${k.padEnd(w)}  ${v}`);
  if (s.cards.pending.length) {
    out.push(`Card payment categories not linked yet: ${s.cards.pending.join(", ")}`);
    out.push(`  link with --card "<name>=<accountId>" (the card must be on budget; --on-budget <accountId> moves an inbox account)`);
  }
  for (const m of s.verify.mismatches.slice(0, 40)) {
    out.push(`  ${m.group} / ${m.category}: ${m.field} YNAB ${formatMilli(m.file)} vs Hearth ${m.hearth === null ? "(missing)" : formatMilli(m.hearth)}`);
  }
  if (s.warnings.length) out.push(`Warnings (${s.warnings.length}):`, ...s.warnings.slice(0, 40).map((x) => `  ${x}`));
  return out.join("\n");
}
