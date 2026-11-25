import "server-only";
/**
 * Backups (§4.6, infra ADR "backups are a sidecar loop"): the backup sidecar writes
 * homebase-YYYYMMDD-HHMMSS.dump plus .last-success ("<iso> <file>") / .last-failure into BACKUP_DIR.
 * The web container needs that directory mounted read-only to show it here.
 */
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";

export const backupDir = () => process.env.BACKUP_DIR?.trim() || "/backups";
export const DUMP_NAME = /^homebase-\d{8}-\d{6}\.dump$/;

export interface BackupState {
  mounted: boolean;
  dir: string;
  lastSuccess: { at: string; file: string | null } | null;
  lastFailure: string | null;
  /** Hours since the last success (null when never / unreadable). */
  ageHours: number | null;
  dumps: { name: string; bytes: number; modified: string }[];
}

export async function readBackupState(dir = backupDir()): Promise<BackupState> {
  try {
    const s = await stat(dir);
    if (!s.isDirectory()) return { mounted: false, dir, lastSuccess: null, lastFailure: null, ageHours: null, dumps: [] };
  } catch {
    return { mounted: false, dir, lastSuccess: null, lastFailure: null, ageHours: null, dumps: [] };
  }
  const text = async (f: string) => (await readFile(join(dir, f), "utf8").catch(() => null))?.trim() || null;
  const ok = await text(".last-success");
  const fail = await text(".last-failure");
  const names = (await readdir(dir).catch(() => [] as string[])).filter((n) => DUMP_NAME.test(n));
  const dumps = (
    await Promise.all(
      names.map(async (name) => {
        const st = await stat(join(dir, name)).catch(() => null);
        return st ? { name, bytes: st.size, modified: st.mtime.toISOString() } : null;
      }),
    )
  )
    .filter((d): d is NonNullable<typeof d> => !!d)
    .sort((a, b) => (a.name < b.name ? 1 : -1));
  const [raw, file] = ok ? ok.split(/\s+/) : [];
  // pgdump.sh writes `date +%Y-%m-%dT%H:%M:%S%z` ("…-0400"); make the offset ISO ("-04:00").
  const at = raw?.replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  const t = at ? new Date(at).getTime() : Number.NaN;
  const ageHours = Number.isNaN(t) ? null : (Date.now() - t) / 3_600_000;
  return { mounted: true, dir, lastSuccess: ok ? { at: at!, file: file ?? null } : null, lastFailure: fail, ageHours, dumps };
}

/** Resolve a dump by name, refusing anything that isn't a plain dump file name in BACKUP_DIR. */
export function dumpPath(name: string, dir = backupDir()): string | null {
  const n = basename(name);
  return n === name && DUMP_NAME.test(n) ? join(dir, n) : null;
}
