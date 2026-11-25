import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { SerwistProvider } from "@serwist/next/react";
import { ToastProvider } from "@/components/ui/Toast";
import { BRAND } from "@/lib/brand";
import { accentAttrs } from "@/lib/accent";
import { getCurrentUser } from "@/server/auth";
import { getSidebarPref, getThemePref } from "@/server/theme";
import "./globals.css";

const geist = Geist({ subsets: ["latin"], weight: ["400", "500", "600", "700"], variable: "--font-geist", display: "swap" });
const geistMono = Geist_Mono({ subsets: ["latin"], weight: ["400", "500"], variable: "--font-geist-mono", display: "swap" });

export const metadata: Metadata = {
  title: { default: BRAND.name, template: `%s · ${BRAND.name}` },
  description: `${BRAND.tagline}: buckets, transactions and accounts for one household.`,
  applicationName: BRAND.name,
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, title: BRAND.name, statusBarStyle: "default" },
  formatDetection: { telephone: false, email: false, address: false },
  icons: {
    icon: [
      { url: "/icon.svg", type: "image/svg+xml" },
      { url: "/icons/favicon-32.png", sizes: "32x32", type: "image/png" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180" }],
  },
  robots: { index: false, follow: false },
  other: { "mobile-web-app-capable": "yes" },
};

/** Status-bar color follows the canvas of the chosen theme (system: both, by media query). */
export async function generateViewport(): Promise<Viewport> {
  const theme = await getThemePref();
  const LIGHT = "#f3f4f8";
  const DARK = "#0c0c0e";
  return {
    width: "device-width",
    initialScale: 1,
    viewportFit: "cover",
    themeColor:
      theme === "system"
        ? [
            { media: "(prefers-color-scheme: light)", color: LIGHT },
            { media: "(prefers-color-scheme: dark)", color: DARK },
          ]
        : theme === "dark"
          ? DARK
          : LIGHT,
  };
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const [theme, sidebar] = [await getThemePref(), await getSidebarPref()];
  // The signed-in user's accent colors the whole document (portaled sheets included).
  const accent = accentAttrs((await getCurrentUser().catch(() => null))?.user.accent ?? null);
  return (
    <html
      lang="en"
      data-theme={theme}
      data-accent={accent["data-accent"]}
      style={accent.style}
      data-sidebar={sidebar === "collapsed" ? "collapsed" : undefined}
      className={`${geist.variable} ${geistMono.variable}`}
      suppressHydrationWarning
    >
      <body>
        <SerwistProvider swUrl="/sw.js" disable={process.env.NODE_ENV === "development"} cacheOnNavigation={false} reloadOnOnline={false}>
          <ToastProvider>{children}</ToastProvider>
        </SerwistProvider>
      </body>
    </html>
  );
}
