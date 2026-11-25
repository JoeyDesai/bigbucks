import type { MetadataRoute } from "next";

/** Private household app: ask every crawler to stay out. Pages also send X-Robots-Tag: noindex (next.config.ts). */
export default function robots(): MetadataRoute.Robots {
  return { rules: { userAgent: "*", disallow: "/" } };
}
