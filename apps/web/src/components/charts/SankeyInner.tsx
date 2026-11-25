"use client";
import ReactEChartsCore from "echarts-for-react/lib/core";
import * as echarts from "echarts/core";
import { SankeyChart as ESankey } from "echarts/charts";
import { TooltipComponent } from "echarts/components";
import { SVGRenderer } from "echarts/renderers";
import { useChartTheme } from "./tokens";
import { fmtDollars, toChartNumber } from "./util";
import type { SankeyChartProps } from "./SankeyChart";

echarts.use([ESankey, TooltipComponent, SVGRenderer]);

export default function SankeyInner({ nodes, links }: SankeyChartProps) {
  const t = useChartTheme();
  const option = {
    animationDuration: 500,
    tooltip: {
      trigger: "item",
      backgroundColor: t.paper,
      borderColor: t.rule,
      borderWidth: 1,
      textStyle: { color: t.ink, fontFamily: t.font, fontSize: 12 },
      extraCssText: "border-radius:2px;box-shadow:none;",
      valueFormatter: (v: number) => fmtDollars(v),
    },
    series: [
      {
        type: "sankey",
        left: 4,
        right: 120,
        top: 8,
        bottom: 8,
        nodeWidth: 8,
        nodeGap: 10,
        draggable: false,
        emphasis: { focus: "adjacency" },
        data: nodes.map((name, i) => ({ name, itemStyle: { color: t.series[i % t.series.length], borderWidth: 0 } })),
        links: links.map((l) => ({ source: l.source, target: l.target, value: toChartNumber(l.value) })),
        lineStyle: { color: "gradient", opacity: 0.22, curveness: 0.5 },
        label: { color: t.ink2, fontFamily: t.font, fontSize: 11 },
      },
    ],
  };
  return <ReactEChartsCore echarts={echarts} option={option} notMerge lazyUpdate style={{ height: "100%", width: "100%" }} opts={{ renderer: "svg" }} />;
}
