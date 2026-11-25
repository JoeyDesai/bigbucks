/**
 * Golden-test entry point for the YNAB → BudgetSnapshot mapper. The implementation lives in
 * src/ynab.ts (exported from the package as `ynabPlanToSnapshot`) because the importer reuses it.
 */
export { ynabPlanToSnapshot, unwrapYnabPlan, type YnabMapResult, type YnabExpectedMonth, type YnabPlan } from "../../src/ynab";
