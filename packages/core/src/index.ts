/**
 * @homebase/core — domain services between the database and the UI / worker / AI tools.
 *
 * Reads take a Drizzle `db` (or open transaction); writes take a `Ctx { db, userId, actor, confirmedBy?, today? }`
 * and run in one transaction that writes audit_log (and budget_operations for budget changes) and refreshes
 * the engine cache from the earliest affected month. All money is bigint milliunits.
 */
export * from "./context";
export * from "./errors";
export { toJson, stableStringify, type Json } from "./json";
export * from "./audit";
export * from "./settings";
export * from "./users";
export * from "./memory";
export * from "./payees";
export * from "./reports";
export * from "./reports/index";
export * from "./overview";

// budget
export { loadSnapshot, lastAssignedMonth } from "./budget/snapshot";
export {
  recompute,
  ensureFresh,
  invalidateBudget,
  budgetFingerprint,
  readCacheState,
  clearBudgetMemo,
  beginBudgetWrite,
  runEngine,
  throughMonth,
  CACHE_STATE_KEY,
  type CacheState,
  type RecomputeOptions,
  type RecomputeResult,
  type FreshBudget,
  type BudgetWrite,
} from "./budget/cache";
export * from "./budget/operations";
export * from "./budget/view";
export { ROW_TABLES, type RowChange, type RowTable } from "./budget/rowChanges";

// transactions, accounts, scheduled
export * from "./transactions";

// wealth
export * from "./wealth";

// simple bucket budget (Budget screen bars, account balance history)
export * from "./buckets/index";
