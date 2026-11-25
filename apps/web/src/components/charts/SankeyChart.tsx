"use client";
import dynamic from "next/dynamic";
import { Skeleton } from "@/components/ui/Skeleton";

export interface SankeyChartProps {
  nodes: string[];
  links: { source: string; target: string; value: bigint }[];
}

/** ECharts sankey (cash flow: income → groups → categories). Client-only; reads token colors. */
export const SankeyChart = dynamic<SankeyChartProps>(() => import("./SankeyInner"), {
  ssr: false,
  loading: () => <Skeleton className="h-full w-full" height="100%" />,
});
