import "server-only";
import { createDb, type Db } from "@homebase/db";

// One pool per server process; survives Next dev hot reloads via globalThis.
const g = globalThis as unknown as { __homebaseDb?: ReturnType<typeof createDb> };

export function getDb(): Db {
  g.__homebaseDb ??= createDb(process.env.DATABASE_URL);
  return g.__homebaseDb.db;
}
