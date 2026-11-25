/** Connector factory registry for the sync service. Importers (CSV/OFX/River/Fidelity/xpub) are functions, not connectors. */
import type { HttpClientOptions } from "./http";
import { createCoinbaseConnector, type CoinbaseCreds } from "./coinbase";
import { createMercuryConnector, type MercuryCreds } from "./mercury";
import { createRentcastConnector, type RentcastCreds } from "./rentcast";
import { createSimplefinConnector, type SimplefinCreds } from "./simplefin";
import type { Connector } from "./types";

export interface ConnectorCredsByProvider {
  simplefin: SimplefinCreds;
  mercury: MercuryCreds;
  coinbase: CoinbaseCreds;
  rentcast: RentcastCreds;
}
export type NetworkConnectorProvider = keyof ConnectorCredsByProvider;

/** Build a connector by provider with shared HTTP options (inject `fetch` in tests). */
export function createConnector<P extends NetworkConnectorProvider>(provider: P, o: { http?: HttpClientOptions } = {}): Connector<ConnectorCredsByProvider[P]> {
  const http = o.http ? { http: o.http } : {};
  const make: { [K in NetworkConnectorProvider]: () => Connector<ConnectorCredsByProvider[K]> } = {
    simplefin: () => createSimplefinConnector(http),
    mercury: () => createMercuryConnector(http),
    coinbase: () => createCoinbaseConnector(http),
    rentcast: () => createRentcastConnector(http),
  };
  return make[provider]() as Connector<ConnectorCredsByProvider[P]>;
}
