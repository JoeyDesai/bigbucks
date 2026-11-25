/**
 * Bind check for the production listen address (HOSTNAME=127.0.0.2, see header-trust.ts).
 *
 * Linux-container-only: Linux routes all of 127.0.0.0/8 to `lo`, so Node (and Next.js standalone,
 * which calls server.listen(PORT, HOSTNAME)) can bind 127.0.0.2 with no setup. macOS only configures
 * 127.0.0.1 on lo0 (127.0.0.2 gives EADDRNOTAVAIL), which is why local dev stays on 127.0.0.1 with
 * header trust off. CI (ubuntu) and the production container run the real check.
 */
import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_LISTEN_HOST } from "./header-trust";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

function listen(host: string): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer((_req, res) => res.end("ok"));
    servers.push(server);
    server.once("error", reject);
    server.listen(0, host, () => {
      const addr = server.address();
      resolve({ server, port: typeof addr === "object" && addr ? addr.port : 0 });
    });
  });
}

function tcpConnects(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect({ host, port });
    s.once("connect", () => (s.destroy(), resolve(true)));
    s.once("error", () => resolve(false));
  });
}

describe("listen on the dedicated loopback alias", () => {
  it(`binds ${DEFAULT_LISTEN_HOST}, serves HTTP there, and is NOT reachable on 127.0.0.1 / ::1 (the netstack forward targets)`, async (ctx) => {
    let port: number;
    try {
      ({ port } = await listen(DEFAULT_LISTEN_HOST));
    } catch (e) {
      // Expected on macOS (no 127.0.0.2 on lo0 unless someone added an alias); must work on Linux.
      if (process.platform !== "linux" && (e as NodeJS.ErrnoException).code === "EADDRNOTAVAIL") return ctx.skip();
      throw e;
    }
    const res = await fetch(`http://${DEFAULT_LISTEN_HOST}:${port}/`);
    expect(await res.text()).toBe("ok");
    expect(await tcpConnects("127.0.0.1", port)).toBe(false);
    expect(await tcpConnects("::1", port)).toBe(false);
  });
});
