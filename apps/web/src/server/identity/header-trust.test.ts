import { describe, expect, it } from "vitest";
import { evaluateTailscaleTrust, isDedicatedLoopbackAlias, isTailscaleHeader, isTailscaleIp, lastForwardedHop } from "./header-trust";

const env = { trustFlag: "1", listenHost: "127.0.0.2" };
const h = (o: Record<string, string>) => new Headers(o);
const serve = {
  host: "homebase.tail1234.ts.net",
  "x-forwarded-for": "100.101.5.7",
  "tailscale-user-login": "alex@example.com",
  "tailscale-user-name": "Alex Rivera",
};

describe("isTailscaleIp", () => {
  it.each([
    ["100.64.0.1", true],
    ["100.127.255.254", true],
    ["100.63.255.255", false],
    ["100.128.0.0", false],
    ["::ffff:100.100.1.1", true],
    ["fd7a:115c:a1e0:ab12::1", true],
    ["fd7a:115c:a1e1::1", false],
    ["127.0.0.1", false],
    ["192.0.2.20", false],
    ["garbage", false],
  ])("%s → %s", (ip, want) => expect(isTailscaleIp(ip)).toBe(want));
});

describe("isDedicatedLoopbackAlias", () => {
  it.each([
    ["127.0.0.2", true],
    ["127.1.2.3", true],
    ["127.255.255.254", true],
    ["127.0.0.1", false],
    ["::1", false],
    ["localhost", false],
    ["0.0.0.0", false],
    ["128.0.0.2", false],
    ["", false],
    [undefined, false],
  ])("%s → %s", (host, want) => expect(isDedicatedLoopbackAlias(host)).toBe(want));
});

describe("lastForwardedHop", () => {
  it("takes the hop appended by the nearest proxy", () => {
    expect(lastForwardedHop("1.2.3.4, 100.70.0.9")).toBe("100.70.0.9");
    expect(lastForwardedHop(null)).toBeNull();
  });
});

describe("evaluateTailscaleTrust", () => {
  it("trusts a request proxied by Serve from a tailnet IP", () => {
    expect(evaluateTailscaleTrust(h(serve), env)).toEqual({ trusted: true, login: "alex@example.com", name: "Alex Rivera" });
  });
  it("is off unless the flag is set", () => {
    expect(evaluateTailscaleTrust(h(serve), { ...env, trustFlag: undefined }).trusted).toBe(false);
  });
  it("is off when the server is not bound to loopback", () => {
    expect(evaluateTailscaleTrust(h(serve), { ...env, listenHost: "0.0.0.0" }).trusted).toBe(false);
    expect(evaluateTailscaleTrust(h(serve), { ...env, listenHost: undefined }).trusted).toBe(false);
  });
  it("is off when bound to 127.0.0.1 / ::1 / localhost (userspace tailscaled forwards raw tailnet TCP there)", () => {
    // The attack: a tailnet peer curls http://100.x:3000 directly with forged Serve headers. Every
    // header looks exactly like Serve's; only the bind address tells the two apart.
    const forged = { ...serve, "x-forwarded-for": "100.64.0.1", "tailscale-user-login": "alex@example.com" };
    for (const listenHost of ["127.0.0.1", "::1", "localhost"]) {
      expect(evaluateTailscaleTrust(h(forged), { ...env, listenHost })).toEqual({ trusted: false, reason: "not bound to the dedicated loopback alias" });
    }
  });
  it("requires HOSTNAME to equal HOMEBASE_LISTEN_HOST, which must be a 127/8 alias other than 127.0.0.1", () => {
    expect(evaluateTailscaleTrust(h(serve), { ...env, listenHost: "127.0.0.5", requiredListenHost: "127.0.0.5" }).trusted).toBe(true);
    expect(evaluateTailscaleTrust(h(serve), { ...env, listenHost: "127.0.0.2", requiredListenHost: "127.0.0.5" }).trusted).toBe(false);
    for (const bad of ["127.0.0.1", "::1", "localhost", "0.0.0.0", "10.0.0.2"]) {
      const d = evaluateTailscaleTrust(h(serve), { ...env, listenHost: bad, requiredListenHost: bad });
      expect(d).toEqual({ trusted: false, reason: "HOMEBASE_LISTEN_HOST is not a dedicated loopback alias" });
    }
  });
  it("rejects a direct loopback request (Next fills XFF with 127.0.0.1)", () => {
    expect(evaluateTailscaleTrust(h({ ...serve, "x-forwarded-for": "127.0.0.1" }), env).trusted).toBe(false);
  });
  it("ignores a client-forged tailnet IP to the left of the real hop", () => {
    expect(evaluateTailscaleTrust(h({ ...serve, "x-forwarded-for": "100.64.0.1, 203.0.113.9" }), env).trusted).toBe(false);
  });
  it("requires the ts.net host (or the configured public host)", () => {
    expect(evaluateTailscaleTrust(h({ ...serve, host: "192.0.2.20:3000" }), env).trusted).toBe(false);
    expect(evaluateTailscaleTrust(h({ ...serve, host: "x.example.com" }), { ...env, publicHost: "x.example.com" }).trusted).toBe(true);
    expect(evaluateTailscaleTrust(h(serve), { ...env, publicHost: "other.ts.net" }).trusted).toBe(false);
  });
  it("gives no identity for tagged nodes / missing login", () => {
    const { ["tailscale-user-login"]: _drop, ...rest } = serve;
    expect(evaluateTailscaleTrust(h(rest), env).trusted).toBe(false);
    expect(evaluateTailscaleTrust(h({ ...serve, "tailscale-user-login": "tagged-devices" }), env).trusted).toBe(false);
  });
  it("identifies Tailscale headers for stripping", () => {
    expect(isTailscaleHeader("Tailscale-User-Login")).toBe(true);
    expect(isTailscaleHeader("x-forwarded-for")).toBe(false);
  });
});
