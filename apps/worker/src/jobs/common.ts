/** Shared pieces for job handlers. */
import type { HttpClientOptions } from "@homebase/connectors";
import type { WorkerContext } from "../context";
import type { SecretsDeps } from "../secrets";
import type { SyncTrigger } from "../ingest/syncRuns";

/** A job failure that names the connections involved, so the final retry can mark them `error` (§8.1). */
export class JobError extends Error {
  readonly connectionIds: string[];
  constructor(message: string, connectionIds: string[] = [], opts?: { cause?: unknown }) {
    super(message, opts);
    this.name = "JobError";
    this.connectionIds = connectionIds;
  }
}

export interface SyncSummary {
  connectionId: string;
  provider: string;
  status: "ok" | "partial" | "error" | "skipped" | "needs_attention";
  reason?: string;
  requestsUsed: number;
  accountsSeen?: number;
  txAdded?: number;
  txUpdated?: number;
  newInboxAccounts?: number;
}

export interface SyncJobData {
  trigger?: SyncTrigger;
}

export function secretsDeps(ctx: WorkerContext): SecretsDeps {
  return { db: ctx.db, log: ctx.log, keyring: ctx.keyring, env: ctx.env };
}

/** Wrap HTTP options so every outgoing request is counted (sync_runs.requests_used). */
export function countingHttp(base: HttpClientOptions | undefined, onRequest: () => void | Promise<void>, extra: Partial<HttpClientOptions> = {}): HttpClientOptions {
  return {
    ...(base ?? {}),
    ...extra,
    beforeRequest: async (req) => {
      await onRequest();
      await base?.beforeRequest?.(req);
    },
  };
}

/** Run a per-connection sync for every connection; collect failures and rethrow one JobError for retry. */
export async function forEachConnection<T extends { connection: { id: string } }>(
  ctx: WorkerContext,
  provider: string,
  items: T[],
  fn: (item: T) => Promise<SyncSummary>,
): Promise<SyncSummary[]> {
  const out: SyncSummary[] = [];
  const failed: string[] = [];
  const messages: string[] = [];
  for (const it of items) {
    try {
      out.push(await fn(it));
    } catch (e) {
      failed.push(it.connection.id);
      messages.push((e as Error).message);
      ctx.log.error({ provider, connectionId: it.connection.id, err: (e as Error).message }, "sync failed");
    }
  }
  if (failed.length) throw new JobError(`${provider} sync failed: ${messages.join("; ")}`, failed);
  if (!items.length) ctx.log.info({ provider }, "no connection configured; nothing to sync");
  return out;
}
