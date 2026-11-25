import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { FetchLike } from "../src/http";

const here = dirname(fileURLToPath(import.meta.url));
export const fixturePath = (name: string) => join(here, "fixtures", name);
export const fixtureText = (name: string) => readFileSync(fixturePath(name), "utf8");
export const fixtureJson = <T = unknown>(name: string): T => JSON.parse(fixtureText(name)) as T;

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

export type Route = (url: URL, call: RecordedCall) => Response | Promise<Response> | undefined;

/** A fetch stand-in that records every call and answers from routes; unmatched calls fail the test. */
export function mockFetch(...routes: Route[]): { fetch: FetchLike; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetch: FetchLike = async (input, init = {}) => {
    const headers: Record<string, string> = {};
    const h = init.headers;
    if (h && typeof h === "object" && !Array.isArray(h) && !(h instanceof Headers)) for (const [k, v] of Object.entries(h)) headers[k.toLowerCase()] = String(v);
    const call: RecordedCall = { url: input, method: (init.method ?? "GET").toUpperCase(), headers, body: init.body };
    calls.push(call);
    for (const r of routes) {
      const res = await r(new URL(input), call);
      if (res) return res;
    }
    throw new Error(`mockFetch: no route for ${call.method} ${input}`);
  };
  return { fetch, calls };
}

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

export const noSleep = async () => {};
