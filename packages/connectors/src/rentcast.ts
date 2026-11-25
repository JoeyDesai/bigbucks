/**
 * RentCast AVM (§7.6): GET https://api.rentcast.io/v1/avm/value with X-Api-Key.
 * Free plan = 50 calls/month; the app hard-caps at 5/month (pure helper below).
 */
import { z } from "zod";
import type { Milli } from "@homebase/shared";
import { createHttpClient, type HttpClientOptions } from "./http";
import { toMilli } from "./normalize";
import { ConnectorError, type Connector } from "./types";

export const RENTCAST_BASE_URL = "https://api.rentcast.io/v1";
export const RENTCAST_MONTHLY_CAP = 5;

const n = z.number().nullish();
const s = z.string().nullish();
const PropertySchema = z.looseObject({
  id: s,
  formattedAddress: s,
  city: s,
  state: s,
  zipCode: s,
  propertyType: s,
  bedrooms: n,
  bathrooms: n,
  squareFootage: n,
  lotSize: n,
  yearBuilt: n,
  latitude: n,
  longitude: n,
  lastSaleDate: s,
  lastSalePrice: n,
});
const CompSchema = PropertySchema.extend({
  price: n,
  status: s,
  listingType: s,
  listedDate: s,
  removedDate: s,
  lastSeenDate: s,
  daysOnMarket: n,
  distance: n,
  daysOld: n,
  correlation: n,
});
export const RentcastAvmSchema = z.looseObject({
  price: z.number(),
  priceRangeLow: z.number().nullish(),
  priceRangeHigh: z.number().nullish(),
  subjectProperty: PropertySchema.nullish(),
  comparables: z.array(CompSchema).nullish(),
});

export interface RentcastComp {
  id?: string;
  address?: string;
  price?: Milli;
  bedrooms?: number;
  bathrooms?: number;
  squareFootage?: number;
  distanceMiles?: number;
  daysOld?: number;
  correlation?: number;
  listedDate?: string;
  status?: string;
}

export interface RentcastValuation {
  price: Milli;
  priceRangeLow?: Milli;
  priceRangeHigh?: Milli;
  subjectProperty?: z.infer<typeof PropertySchema>;
  comparables: RentcastComp[];
  raw: unknown;
}

export interface RentcastQuery {
  address: string;
  propertyType?: string;
  bedrooms?: number;
  bathrooms?: number;
  squareFootage?: number;
  compCount?: number;
}

export function mapRentcastAvm(json: unknown): RentcastValuation {
  const r = RentcastAvmSchema.parse(json);
  const out: RentcastValuation = {
    price: toMilli(r.price),
    comparables: (r.comparables ?? []).map((c) => {
      const comp: RentcastComp = {};
      if (c.id) comp.id = c.id;
      if (c.formattedAddress) comp.address = c.formattedAddress;
      if (c.price !== null && c.price !== undefined) comp.price = toMilli(c.price);
      if (c.bedrooms != null) comp.bedrooms = c.bedrooms;
      if (c.bathrooms != null) comp.bathrooms = c.bathrooms;
      if (c.squareFootage != null) comp.squareFootage = c.squareFootage;
      if (c.distance != null) comp.distanceMiles = c.distance;
      if (c.daysOld != null) comp.daysOld = c.daysOld;
      if (c.correlation != null) comp.correlation = c.correlation;
      if (c.listedDate) comp.listedDate = c.listedDate;
      if (c.status) comp.status = c.status;
      return comp;
    }),
    raw: json,
  };
  if (r.priceRangeLow != null) out.priceRangeLow = toMilli(r.priceRangeLow);
  if (r.priceRangeHigh != null) out.priceRangeHigh = toMilli(r.priceRangeHigh);
  if (r.subjectProperty) out.subjectProperty = r.subjectProperty;
  return out;
}

/** Pure monthly cap check (§7.6: hard cap 5/month). */
export function checkRentcastBudget(usedThisMonth: number, cap = RENTCAST_MONTHLY_CAP): { allowed: boolean; remaining: number } {
  const remaining = Math.max(0, cap - usedThisMonth);
  return { allowed: remaining > 0, remaining };
}

export async function getRentcastValue(apiKey: string, q: RentcastQuery, httpOpts: HttpClientOptions = {}, baseUrl = RENTCAST_BASE_URL): Promise<RentcastValuation> {
  if (!q.address.trim()) throw new ConnectorError("invalid_input", "RentCast needs a full address", { provider: "rentcast" });
  const http = createHttpClient({ ...httpOpts, provider: "rentcast", secrets: [...(httpOpts.secrets ?? []), apiKey] });
  const json = await http.getJson(`${baseUrl}/avm/value`, {
    headers: { "x-api-key": apiKey },
    query: { address: q.address, propertyType: q.propertyType, bedrooms: q.bedrooms, bathrooms: q.bathrooms, squareFootage: q.squareFootage, compCount: q.compCount },
  });
  return mapRentcastAvm(json);
}

export interface RentcastCreds {
  apiKey: string;
  property: RentcastQuery;
  /** Stable id for the home's `property` tracking account. */
  accountId?: string;
}

/** Adapter so the home value looks like a connector: one `property` account, no transactions. */
export function createRentcastConnector(o: { http?: HttpClientOptions; baseUrl?: string; now?: () => Date } = {}): Connector<RentcastCreds> & { valuate(c: RentcastCreds): Promise<RentcastValuation> } {
  const now = o.now ?? (() => new Date());
  const valuate = (c: RentcastCreds) => getRentcastValue(c.apiKey, c.property, o.http, o.baseUrl);
  return {
    provider: "rentcast",
    valuate,
    async test(c) {
      // Testing spends a metered call, so only validate locally.
      if (!c.apiKey || c.apiKey.length < 8) return { ok: false, message: "RentCast API key looks invalid" };
      if (!c.property.address.trim()) return { ok: false, message: "Property address is required" };
      return { ok: true, message: "Key and address present (not verified: each RentCast call is metered)" };
    },
    async listAccounts(c) {
      const v = await valuate(c);
      return [{ externalId: c.accountId ?? "rentcast:home", name: v.subjectProperty?.formattedAddress ?? c.property.address, kindGuess: "property", currency: "USD", balance: v.price, asOf: now().toISOString(), institution: "RentCast", raw: v.raw }];
    },
    async fetchTransactions() {
      return [];
    },
  };
}
