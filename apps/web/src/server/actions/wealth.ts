"use server";
/** Wealth actions: mortgage what-if simulator (a read) and the manual home value override. */
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { mortgageDetail, setHomeValue } from "@homebase/core";
import { today } from "@homebase/shared";
import { getDb } from "../db";
import { requireUser } from "../auth";
import { run, type ActionResult } from "../ctx";
import { yearlyBalances } from "../queries/wealth";

const Id = z.string().uuid();
const Date_ = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export interface ScenarioVM {
  payoffDate: string | null;
  totalInterest: bigint;
  interestSaved: bigint;
  monthsSaved: number;
  newPayment: bigint | null;
  series: { date: string; balance: bigint }[];
}

const Scenario = z.object({
  extraMonthly: z.bigint().nonnegative().optional(),
  lumpSum: z.object({ date: Date_, amount: z.bigint().positive() }).optional(),
  recast: z.object({ date: Date_, lumpSum: z.bigint().nonnegative().optional() }).optional(),
});

export async function mortgageScenarioAction(accountId: string, scenario: z.input<typeof Scenario>): Promise<ActionResult<{ scenario: ScenarioVM | null }>> {
  await requireUser();
  const id = Id.parse(accountId);
  const s = Scenario.parse(scenario);
  try {
    const d = await mortgageDetail(getDb(), id, { today: today(), scenario: s });
    if (!d.scenario) return { ok: true, scenario: null };
    return {
      ok: true,
      scenario: {
        payoffDate: d.scenario.payoffDate,
        totalInterest: d.scenario.totalInterest,
        interestSaved: d.scenario.interestSaved,
        monthsSaved: d.scenario.monthsSaved,
        newPayment: d.scenario.newPayment,
        series: yearlyBalances(d.scenario.schedule.rows),
      },
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Couldn't run that scenario." };
  }
}

export async function setHomeValueAction(input: { assetId: string; value: bigint }): Promise<ActionResult> {
  const i = z.object({ assetId: Id, value: z.bigint().positive() }).parse(input);
  return run("home_value", async (ctx) => {
    await setHomeValue(ctx, { assetId: i.assetId, value: i.value });
    revalidatePath("/wealth", "layout");
    return {};
  });
}
