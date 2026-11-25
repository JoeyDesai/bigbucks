/** YNAB API reads for the importer (GET only; the connectors client refuses anything else). */
import { createYnabClient, type HttpClientOptions } from "@homebase/connectors";

/** The raw `GET /plans/{id}` response shape (what the engine's golden test reads). */
export interface YnabPlanResponse {
  data: { plan: unknown; server_knowledge: number };
}

/** The plan to import: `plan` (an id or a name) when given, else YNAB's default plan, else the only one. */
export async function resolvePlanId(token: string, plan: string | undefined, http?: HttpClientOptions): Promise<{ id: string; name: string }> {
  const client = createYnabClient(token, http ? { http } : {});
  const { plans, defaultPlanId } = await client.getPlans();
  const available = plans.map((p) => p.name).join(", ") || "none";
  if (plan) {
    const hit = plans.find((p) => p.id === plan) ?? plans.find((p) => p.name === plan);
    if (!hit) throw new Error(`YNAB plan "${plan}" not found (available: ${available})`);
    return { id: hit.id, name: hit.name };
  }
  const hit = plans.find((p) => p.id === defaultPlanId) ?? (plans.length === 1 ? plans[0] : undefined);
  if (!hit) throw new Error(`Pick a YNAB plan with --plan or YNAB_PLAN_NAME (available: ${available})`);
  return { id: hit.id, name: hit.name };
}

/** Full export (one request) or a `last_knowledge_of_server` delta. */
export async function fetchPlanExport(token: string, planId: string, o: { lastKnowledge?: number; http?: HttpClientOptions } = {}): Promise<YnabPlanResponse> {
  const client = createYnabClient(token, o.http ? { http: o.http } : {});
  const env = await client.getPlanExport(planId, o.lastKnowledge);
  return { data: { plan: env.plan, server_knowledge: env.server_knowledge } };
}
