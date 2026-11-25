/**
 * @homebase/engine — pure, deterministic YNAB-equivalent budget engine (spec §6).
 * Depends only on @homebase/shared. No DB, network, or clock access.
 */
export * from "./types";
export { computeBudget, resolveOptions, DEFAULT_OPTIONS, categoryStatus, orderedBudgetCategories, suggestedCardPayment } from "./budget";
export {
  computeTargetMonth,
  targetNeed,
  effectiveTarget,
  indexTargets,
  targetPeriod,
  periodMonths,
  weeklyDueDates,
  targetDue,
  ceilCentsDiv,
  parsePercent,
  percentOf,
  mapYnabGoal,
  mapYnabCadence,
  YNAB_GOAL_CADENCE,
  type TargetInputs,
  type TargetMonth,
  type TargetPeriod,
  type DueRank,
  type YnabGoalFields,
} from "./targets";
export { autoAssign, eligibleCategories } from "./autoAssign";
export { computeAgeOfMoney, computeAgeOfMoneyByMonth, ageOfMoneyOutflows, type AgeOfMoneyOptions, type AgeOfMoneyOutflow } from "./ageOfMoney";
export { RTA, getAssigned, assign, assignExpression, moveMoney, invertChanges, mergeChanges, applyChanges, rtaDelta, type AssignmentSource } from "./moneyOps";
export { occurrences, occurrencesInMonth } from "./schedule";
export { VIRTUAL_UNCATEGORIZED_ID, virtualPaymentCategoryId, buildLedger, type Ledger, type Line } from "./ledger";
export { ynabPlanToSnapshot, unwrapYnabPlan, type YnabPlan, type YnabMapResult, type YnabMapOptions, type YnabExpectedMonth } from "./ynab";
