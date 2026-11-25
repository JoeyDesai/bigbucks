/**
 * §9.1 categorization pipeline (first match wins, every step can add context):
 *   1. transfer?  2. rules (user > learned)  3. history (incl. amount bands)
 *   4. AI (Haiku, structured output)  5. AI + web lookup for unknown merchants (cached, once)
 *   6. otherwise uncategorized with the top-3 suggestions
 * then the §9.4 approval policy.
 *
 * The pipeline is split into `prepareTransaction` (steps 1–3 + AI input) and `finalizeWithAi`
 * (steps 4–6 + approval) so the Message Batches path can run the AI step asynchronously.
 */
import type { Catz, CatzMethod } from "@homebase/shared";
import { redactDigits, type CatalogCategory, type CategorizeInput, type CategorizeOutcome, type CategorizeResult, type MerchantProfile } from "@homebase/ai";
import type { AiCategorizer } from "./aiAdapter";
import { decideApproval, defaultAlwaysReview, DEFAULT_APPROVAL_SETTINGS, type ApprovalSettings } from "./approval";
import { historyCategory, historySuggestions } from "./history";
import { matchAlias, normalizePayee, normalizedKey, proposeAliasPattern } from "./normalize";
import type { CategorizationEventInput, CategorizerRepo } from "./repo";
import { applyRules, type Rule } from "./rules";
import { accountMap, decideTransfer, TRANSFER_WINDOW_DAYS, type TransferMatch } from "./transfers";
import type { AccountInfo, CategoryInfo, HistoryTxn, PayeeAlias, PayeeRecord, SplitLine, Suggestion, TxnInput } from "./types";

export interface PipelineSettings {
  approval: ApprovalSettings;
  aiEnabled: boolean;
  webLookupEnabled: boolean;
  /** Run the web lookup when AI confidence is below this (and the merchant is unknown). */
  webLookupBelowConfidence: number;
  /** Create the payee alias automatically at or above this AI confidence; otherwise suggest it. */
  aliasAutoCreateMin: number;
  maxSimilar: number;
}

export const DEFAULT_PIPELINE_SETTINGS: PipelineSettings = {
  approval: DEFAULT_APPROVAL_SETTINGS,
  aiEnabled: true,
  webLookupEnabled: true,
  webLookupBelowConfidence: 0.7,
  aliasAutoCreateMin: 0.9,
  maxSimilar: 15,
};

/** Data loaded once per run (or per batch) instead of per transaction. */
export interface PipelineContext {
  catalog: CategoryInfo[];
  categoriesById: Map<string, CategoryInfo>;
  accounts: Map<string, AccountInfo>;
  aliases: PayeeAlias[];
  rules: Rule[];
  memory: string[];
  rtaCategoryId: string | null;
  settings: PipelineSettings;
}

/** categories.always_review flags when any are set; otherwise the §9.4 defaults (Misc, Uncategorized, Savings). */
export function alwaysReviewFromCatalog(catalog: readonly CategoryInfo[]): string[] {
  const flagged = catalog.filter((c) => c.alwaysReview === true).map((c) => c.id);
  return flagged.length > 0 ? flagged : defaultAlwaysReview(catalog);
}

export async function loadPipelineContext(repo: CategorizerRepo, settings: Partial<PipelineSettings> = {}): Promise<PipelineContext> {
  const [catalog, accounts, aliases, rules, memory] = await Promise.all([repo.getCategoryCatalog(), repo.getAccounts(), repo.getAliases(), repo.getRules(), repo.getHouseholdMemory()]);
  const approval: ApprovalSettings = {
    ...DEFAULT_APPROVAL_SETTINGS,
    ...settings.approval,
    alwaysReviewCategoryIds: settings.approval?.alwaysReviewCategoryIds?.length ? settings.approval.alwaysReviewCategoryIds : alwaysReviewFromCatalog(catalog),
  };
  return {
    catalog,
    categoriesById: new Map(catalog.map((c) => [c.id, c])),
    accounts: accountMap(accounts),
    aliases,
    rules,
    memory,
    rtaCategoryId: catalog.find((c) => c.kind === "internal_rta")?.id ?? null,
    settings: { ...DEFAULT_PIPELINE_SETTINGS, ...settings, approval },
  };
}

export interface AliasProposal {
  pattern: string;
  match: "exact" | "prefix";
  payeeName: string;
  /** Create automatically (AI confidence ≥ 0.9) vs. suggest in the review queue. */
  autoCreate: boolean;
}

export interface PipelineResult {
  transactionId: string;
  /** `key` is the final payee key; `originalKey` the one resolved from the descriptor (differs after an AI rename). */
  payee: { payeeId: string | null; name: string; key: string; originalKey: string; aliasProposal: AliasProposal | null };
  categoryId: string | null;
  split: SplitLine[] | null;
  memo: string | null;
  /** Auto-applied transfer pair (step 1), or a rule-driven transfer target. */
  transfer: TransferMatch | null;
  ruleTransferAccountId: string | null;
  transferSuggestions: TransferMatch[];
  approved: boolean;
  reviewReasons: string[];
  catz: Catz;
  /** Top 3 category suggestions for the review queue. */
  suggestions: Suggestion[];
  ai: { calls: number; merchantLookup: "none" | "cached" | "performed" | "skipped" | "unavailable"; inputTokens: number; outputTokens: number; costMicroUsd: bigint };
}

export interface PipelineDeps {
  repo: CategorizerRepo;
  ai?: AiCategorizer | null;
  now?: () => Date;
}

interface Resolved {
  payee: PayeeRecord | null;
  name: string;
  key: string;
  city: string | null;
  state: string | null;
}

/** State carried from steps 1–3 to the AI step. */
export interface PreparedTransaction {
  txn: TxnInput;
  resolved: Resolved;
  /** Set when steps 1–3 decided (no AI needed). */
  decided: PipelineResult | null;
  /** Input for the AI step when not decided. */
  aiInput: CategorizeInput | null;
  history: HistoryTxn[];
  transferSuggestions: TransferMatch[];
  memo: string | null;
  payeeOverride: { payeeId?: string; name?: string } | null;
  ruleAutoApprove: boolean | undefined;
}

function catalogForAi(ctx: PipelineContext): CatalogCategory[] {
  return ctx.catalog
    .filter((c) => !c.hidden)
    .map((c) => ({
      id: c.id,
      group: c.group,
      name: c.name,
      kind: c.kind,
      ...(c.note ? { note: c.note } : {}),
      ...(c.target ? { target: c.target } : {}),
      ...(c.examplePayees ? { examplePayees: c.examplePayees.slice(0, 5) } : {}),
    }));
}

function accountLabel(a: AccountInfo | undefined): string {
  if (!a) return "unknown account";
  return redactDigits(a.llmLabel ?? a.nickname ?? a.name);
}

function topSuggestions(list: Suggestion[], ctx: PipelineContext, k = 3): Suggestion[] {
  const best = new Map<string, Suggestion>();
  for (const s of list) {
    const c = ctx.categoriesById.get(s.categoryId);
    if (!c || c.kind === "cc_payment" || c.kind === "uncategorized") continue;
    const prev = best.get(s.categoryId);
    if (!prev || s.confidence > prev.confidence) best.set(s.categoryId, s);
  }
  return [...best.values()].sort((a, b) => b.confidence - a.confidence).slice(0, k);
}

async function resolvePayee(txn: TxnInput, ctx: PipelineContext, repo: CategorizerRepo): Promise<Resolved> {
  const norm = normalizePayee(txn.rawDescription);
  let payee: PayeeRecord | null = null;
  if (txn.payeeId) payee = await repo.getPayeeById(txn.payeeId);
  if (!payee) {
    const alias = matchAlias(txn.rawDescription, ctx.aliases);
    if (alias) payee = await repo.getPayeeById(alias.payeeId);
  }
  if (!payee) payee = await repo.getPayeeByKey(norm.key);
  return { payee, name: payee?.name ?? norm.name, key: payee?.normalizedKey ?? norm.key, city: norm.city, state: norm.state };
}

function blankAi(): PipelineResult["ai"] {
  return { calls: 0, merchantLookup: "none", inputTokens: 0, outputTokens: 0, costMicroUsd: 0n };
}

async function priorReviewed(repo: CategorizerRepo, key: string, ctx: PipelineContext, txn: TxnInput, categoryIds: readonly string[]): Promise<number> {
  const relevant = (txn.amountMilli > 0n && txn.amountMilli > ctx.settings.approval.incomeReviewMinMilli) || (ctx.rtaCategoryId !== null && categoryIds.includes(ctx.rtaCategoryId));
  if (!relevant) return Number.MAX_SAFE_INTEGER;
  return repo.countPriorReviewed(key, { incomeOverMilli: ctx.settings.approval.incomeReviewMinMilli, rtaCategoryId: ctx.rtaCategoryId, before: txn.date });
}

interface Decision {
  method: CatzMethod;
  confidence: number;
  categoryId: string | null;
  split: SplitLine[] | null;
  model?: string;
  ruleId?: string;
  explanation?: string;
}

async function buildResult(
  p: PreparedTransaction,
  d: Decision,
  ctx: PipelineContext,
  deps: PipelineDeps,
  extra: { suggestions: Suggestion[]; reasons: string[]; ai: PipelineResult["ai"]; transfer?: TransferMatch | null; ruleTransferAccountId?: string | null; aliasProposal?: AliasProposal | null; payeeName?: string },
): Promise<PipelineResult> {
  const now = (deps.now ?? (() => new Date()))();
  const categoryIds = d.split ? d.split.map((l) => l.categoryId) : d.categoryId ? [d.categoryId] : [];
  const isTransfer = Boolean(extra.transfer || extra.ruleTransferAccountId);
  let approved = false;
  let categoryId = d.categoryId;
  let split = d.split;
  const reasons = [...extra.reasons];
  if (categoryIds.length > 0 || isTransfer) {
    const decision = decideApproval(
      {
        method: d.method,
        confidence: d.confidence,
        amountMilli: p.txn.amountMilli,
        categoryIds,
        ...(p.ruleAutoApprove !== undefined && d.method === "rule" ? { ruleAutoApprove: p.ruleAutoApprove } : {}),
        toReadyToAssign: ctx.rtaCategoryId !== null && categoryIds.includes(ctx.rtaCategoryId),
        priorReviewedForPayee: await priorReviewed(deps.repo, p.resolved.key, ctx, p.txn, categoryIds),
      },
      ctx.settings.approval,
    );
    approved = decision.approve;
    if (!decision.categorize) {
      categoryId = null;
      split = null;
    }
    if (!decision.approve) reasons.push(...decision.reasons);
  } else {
    reasons.push("no category");
  }
  const suggestions = topSuggestions(extra.suggestions, ctx);
  const name = p.payeeOverride?.name ?? extra.payeeName ?? p.resolved.name;
  const catz: Catz = {
    method: d.method,
    confidence: d.confidence,
    ...(d.model ? { model: d.model } : {}),
    ...(d.ruleId ? { rule_id: d.ruleId } : {}),
    ...(d.explanation ? { explanation: d.explanation } : {}),
    ...(suggestions.length ? { suggestions: suggestions.map((s) => ({ category_id: s.categoryId, confidence: s.confidence })) } : {}),
    at: now.toISOString(),
  };
  return {
    transactionId: p.txn.id,
    payee: {
      payeeId: p.payeeOverride?.payeeId ?? p.resolved.payee?.id ?? null,
      name,
      key: p.payeeOverride?.name ? normalizedKey(p.payeeOverride.name) : extra.payeeName ? normalizedKey(extra.payeeName) : p.resolved.key,
      originalKey: p.resolved.key,
      aliasProposal: extra.aliasProposal ?? null,
    },
    categoryId: split ? null : categoryId,
    split,
    memo: p.memo,
    transfer: extra.transfer ?? null,
    ruleTransferAccountId: extra.ruleTransferAccountId ?? null,
    transferSuggestions: p.transferSuggestions,
    approved,
    reviewReasons: approved ? [] : reasons,
    catz,
    suggestions,
    ai: extra.ai,
  };
}

/** Steps 1–3. Returns a decided result, or the AI input for step 4. */
export async function prepareTransaction(txn: TxnInput, ctx: PipelineContext, deps: PipelineDeps): Promise<PreparedTransaction> {
  const { repo } = deps;
  const resolved = await resolvePayee(txn, ctx, repo);
  const p: PreparedTransaction = { txn, resolved, decided: null, aiInput: null, history: [], transferSuggestions: [], memo: null, payeeOverride: null, ruleAutoApprove: undefined };

  // 1. Transfer
  const candidates = await repo.getTransferCandidates(txn, TRANSFER_WINDOW_DAYS);
  const t = decideTransfer(
    { id: txn.id, accountId: txn.accountId, date: txn.date, amountMilli: txn.amountMilli, rawDescription: txn.rawDescription, payeeName: resolved.name },
    candidates,
    ctx.accounts,
    { rtaCategoryId: ctx.rtaCategoryId },
  );
  p.transferSuggestions = t.suggestions;
  if (t.match) {
    const householdSide = t.match.kind === "business_to_household" && t.match.inflowId === txn.id;
    p.decided = await buildResult(
      p,
      { method: "transfer", confidence: t.match.confidence, categoryId: householdSide ? t.match.householdCategoryId : null, split: null, explanation: t.match.reason },
      ctx,
      deps,
      { suggestions: [], reasons: [], ai: blankAi(), transfer: t.match },
    );
    return p;
  }

  // 2. Rules
  const subject = { payeeName: resolved.name, payeeKey: resolved.key, rawDescription: txn.rawDescription, amountMilli: txn.amountMilli, accountId: txn.accountId, date: txn.date };
  const r = applyRules(ctx.rules, subject);
  if (r.payee) p.payeeOverride = r.payee;
  if (r.memo !== undefined) p.memo = r.memo;
  p.ruleAutoApprove = r.autoApprove;
  if (r.decidingRuleId) {
    const at = (deps.now ?? (() => new Date()))().toISOString();
    await repo.recordRuleHit(r.decidingRuleId, at);
    p.decided = await buildResult(
      p,
      { method: "rule", confidence: 1, categoryId: r.categoryId ?? null, split: r.split ?? null, ruleId: r.decidingRuleId, explanation: `${r.decidingSource} rule` },
      ctx,
      deps,
      { suggestions: [], reasons: r.errors, ai: blankAi(), ruleTransferAccountId: r.transferAccountId ?? null },
    );
    return p;
  }

  // 3. History (and payee default category)
  const key = p.payeeOverride?.name ? normalizedKey(p.payeeOverride.name) : resolved.key;
  p.history = await repo.getPayeeHistory(key, { before: txn.date, limit: 200 });
  const h = historyCategory(p.history, txn.amountMilli);
  if (h) {
    p.decided = await buildResult(
      p,
      { method: "history", confidence: h.confidence, categoryId: h.categoryId, split: null, explanation: h.explanation },
      ctx,
      deps,
      { suggestions: historySuggestions(p.history), reasons: [], ai: blankAi() },
    );
    return p;
  }
  const def = resolved.payee?.defaultCategoryId;
  if (def && ctx.categoriesById.has(def)) {
    p.decided = await buildResult(p, { method: "history", confidence: 0.95, categoryId: def, split: null, explanation: "payee default category" }, ctx, deps, {
      suggestions: historySuggestions(p.history),
      reasons: [],
      ai: blankAi(),
    });
    return p;
  }

  // Prepare the AI input (step 4)
  const similar = await repo.similarTransactions({
    transactionId: txn.id,
    payeeKey: key,
    payeeName: resolved.name,
    rawDescription: txn.rawDescription,
    amountMilli: txn.amountMilli,
    before: txn.date,
    limit: ctx.settings.maxSimilar,
  });
  const account = ctx.accounts.get(txn.accountId);
  p.aiInput = {
    catalog: catalogForAi(ctx),
    householdMemory: ctx.memory,
    transaction: {
      rawDescription: txn.rawDescription,
      normalizedPayee: p.payeeOverride?.name ?? resolved.name,
      amountMilli: txn.amountMilli,
      accountLabel: accountLabel(account),
      ...(account ? { accountKind: account.kind } : {}),
      date: txn.date,
      merchant: resolved.payee?.merchant ?? null,
    },
    similar: similar.slice(0, ctx.settings.maxSimilar),
  };
  return p;
}

function similarSuggestions(input: CategorizeInput | null): Suggestion[] {
  if (!input) return [];
  const counts = new Map<string, number>();
  for (const s of input.similar) if (s.categoryId && !s.isTransfer) counts.set(s.categoryId, (counts.get(s.categoryId) ?? 0) + 1);
  const n = input.similar.length || 1;
  return [...counts.entries()].map(([categoryId, c]) => ({ categoryId, confidence: Math.round((c / n) * 0.6 * 1000) / 1000, source: "history" as const }));
}

/** Steps 4–6 given AI outcomes (null = AI not run). */
export async function finalizeWithAi(
  p: PreparedTransaction,
  ctx: PipelineContext,
  deps: PipelineDeps,
  ai: { outcome: CategorizeOutcome | null; method: "ai" | "ai_web"; stats: PipelineResult["ai"]; reasons?: string[] },
): Promise<PipelineResult> {
  if (p.decided) return p.decided;
  const base: Suggestion[] = [...historySuggestions(p.history), ...similarSuggestions(p.aiInput)];
  const reasons = [...(ai.reasons ?? [])];
  const o = ai.outcome;
  if (!o || !o.ok) {
    if (o && !o.ok) reasons.push(`AI ${o.reason}`);
    return buildResult(p, { method: "history", confidence: 0, categoryId: null, split: null, explanation: "No rule, history or AI match" }, ctx, deps, { suggestions: base, reasons, ai: ai.stats });
  }
  const res: CategorizeResult = o;
  const suggestions = res.categoryId ? [{ categoryId: res.categoryId, confidence: res.confidence, source: ai.method }, ...base] : base;
  if (res.isTransfer) reasons.push("AI thinks this is a transfer; no matching pair found");

  // Payee alias proposal from the AI's clean merchant name (§9.2).
  let aliasProposal: AliasProposal | null = null;
  let payeeName: string | undefined;
  const aiName = res.payeeName.trim();
  if (!p.resolved.payee && !p.payeeOverride && aiName && normalizedKey(aiName) !== p.resolved.key) {
    const pat = proposeAliasPattern(p.txn.rawDescription);
    aliasProposal = { ...pat, payeeName: aiName, autoCreate: res.confidence >= ctx.settings.aliasAutoCreateMin };
    if (aliasProposal.autoCreate) payeeName = aiName;
  } else if (!p.resolved.payee && !p.payeeOverride && aiName && aiName !== p.resolved.name && res.confidence >= ctx.settings.aliasAutoCreateMin) {
    // Same key, nicer display name ("Kesslers Deli" → "Kessler's Deli"): no alias needed.
    payeeName = aiName;
  }

  return buildResult(
    p,
    {
      method: ai.method,
      confidence: res.confidence,
      categoryId: res.isTransfer ? null : res.categoryId,
      split: res.isTransfer ? null : (res.split?.map((l) => ({ categoryId: l.categoryId, amountMilli: l.amountMilli })) ?? null),
      model: res.model,
      explanation: res.explanation,
    },
    ctx,
    deps,
    { suggestions, reasons, ai: ai.stats, aliasProposal, ...(payeeName ? { payeeName } : {}) },
  );
}

function addStats(stats: PipelineResult["ai"], o: CategorizeOutcome): void {
  stats.calls++;
  if (o.ok) {
    stats.inputTokens += o.inputTokens;
    stats.outputTokens += o.outputTokens;
    stats.costMicroUsd += o.costMicroUsd;
  }
}

/** Real-time path: steps 1–6 for one transaction, saving a categorization event. */
export async function categorizeTransaction(txn: TxnInput, deps: PipelineDeps, ctxIn?: PipelineContext, opts: { saveEvent?: boolean } = {}): Promise<PipelineResult> {
  const ctx = ctxIn ?? (await loadPipelineContext(deps.repo));
  const p = await prepareTransaction(txn, ctx, deps);
  let result: PipelineResult;
  if (p.decided) {
    result = p.decided;
  } else {
    const stats = blankAi();
    const reasons: string[] = [];
    let outcome: CategorizeOutcome | null = null;
    let method: "ai" | "ai_web" = "ai";
    const ai = deps.ai ?? null;
    if (!ai || !ctx.settings.aiEnabled) {
      reasons.push("AI categorization is off");
    } else if (!(await ai.isAvailable("categorize"))) {
      reasons.push("AI unavailable (monthly cap reached); rules and history only");
    } else {
      outcome = await ai.categorize(p.aiInput!, { transactionId: txn.id });
      addStats(stats, outcome);
      // 5. Web lookup for unknown merchants: look up once, cache on the payee, re-run step 4.
      const lowConfidence = !outcome.ok || outcome.confidence < ctx.settings.webLookupBelowConfidence || outcome.needsWebLookup;
      const known = p.resolved.payee?.merchant != null;
      if (lowConfidence && !known && outcome.ok) {
        if (!ctx.settings.webLookupEnabled) stats.merchantLookup = "skipped";
        else if (!(await ai.isAvailable("merchant_lookup"))) stats.merchantLookup = "unavailable";
        else {
          const lookup = await ai.lookupMerchant({ merchant: p.aiInput!.transaction.normalizedPayee, city: p.resolved.city, state: p.resolved.state });
          stats.merchantLookup = "performed";
          if (lookup.status === "found" || lookup.status === "not_found") {
            await deps.repo.upsertMerchantProfile(p.resolved.key, p.resolved.name, lookup.profile);
            if (lookup.status === "found" && (await ai.isAvailable("categorize"))) {
              const withProfile: CategorizeInput = { ...p.aiInput!, transaction: { ...p.aiInput!.transaction, merchant: lookup.profile as MerchantProfile } };
              const second = await ai.categorize(withProfile, { transactionId: txn.id });
              addStats(stats, second);
              if (second.ok) {
                outcome = second;
                method = "ai_web";
              }
            }
          } else if (lookup.status === "rejected") {
            reasons.push("web lookup discarded by the privacy guard");
          }
        }
      } else if (known) stats.merchantLookup = "cached";
    }
    result = await finalizeWithAi(p, ctx, deps, { outcome, method, stats, reasons });
  }
  if (opts.saveEvent !== false) await deps.repo.saveEvent(eventFor(result, (deps.now ?? (() => new Date()))()));
  return result;
}

/** categorization_events row for a pipeline result. */
export function eventFor(r: PipelineResult, at: Date): CategorizationEventInput {
  const suggested = r.categoryId ?? r.split?.[0]?.categoryId ?? r.suggestions[0]?.categoryId ?? null;
  return {
    transactionId: r.transactionId,
    payeeKey: r.payee.key,
    suggestedCategoryId: suggested,
    finalCategoryId: r.split ? null : r.categoryId,
    method: r.catz.method,
    confidence: r.catz.confidence,
    model: r.catz.model ?? null,
    inputTokens: r.ai.inputTokens,
    outputTokens: r.ai.outputTokens,
    costMicroUsd: r.ai.costMicroUsd,
    accepted: r.approved ? true : null,
    at: at.toISOString(),
  };
}

