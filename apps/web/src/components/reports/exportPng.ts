/**
 * Client-side PNG export of a report chart: the chart's SVG (Recharts, ECharts' SVG renderer or our
 * own) is cloned with its computed colors inlined (CSS variables don't survive outside the page),
 * drawn onto a 2× canvas under the report title, and downloaded.
 */
const STYLE_PROPS = ["fill", "stroke", "stroke-width", "stroke-dasharray", "stroke-opacity", "fill-opacity", "opacity", "font-size", "font-family", "font-weight", "text-anchor", "dominant-baseline", "visibility"] as const;

function inlineStyles(src: Element, dst: Element): void {
  const cs = getComputedStyle(src);
  const style: string[] = [];
  for (const p of STYLE_PROPS) {
    const v = cs.getPropertyValue(p);
    if (v) style.push(`${p}:${v}`);
  }
  if (cs.display === "none") style.push("display:none");
  dst.setAttribute("style", style.join(";"));
  const a = src.children;
  const b = dst.children;
  for (let i = 0; i < a.length && i < b.length; i++) inlineStyles(a[i]!, b[i]!);
}

function largestSvg(root: Element): SVGSVGElement | null {
  let best: SVGSVGElement | null = null;
  let area = 0;
  root.querySelectorAll("svg").forEach((s) => {
    const r = s.getBoundingClientRect();
    if (r.width * r.height > area) {
      area = r.width * r.height;
      best = s;
    }
  });
  return best;
}

export async function exportChartPng(root: Element, opts: { title: string; subtitle?: string; filename: string }): Promise<void> {
  const svg = largestSvg(root);
  if (!svg) throw new Error("No chart to export");
  const rect = svg.getBoundingClientRect();
  const w = Math.round(rect.width);
  const h = Math.round(rect.height);
  const clone = svg.cloneNode(true) as SVGSVGElement;
  inlineStyles(svg, clone);
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("width", String(w));
  clone.setAttribute("height", String(h));
  if (!clone.getAttribute("viewBox")) clone.setAttribute("viewBox", `0 0 ${w} ${h}`);
  const xml = new XMLSerializer().serializeToString(clone);
  const url = URL.createObjectURL(new Blob([xml], { type: "image/svg+xml;charset=utf-8" }));
  try {
    const img = new Image();
    await new Promise<void>((res, rej) => {
      img.onload = () => res();
      img.onerror = () => rej(new Error("Could not render the chart"));
      img.src = url;
    });
    const body = getComputedStyle(document.body);
    const pad = 24;
    const head = opts.subtitle ? 64 : 44;
    const scale = 2;
    const canvas = document.createElement("canvas");
    canvas.width = (w + pad * 2) * scale;
    canvas.height = (h + head + pad * 2) * scale;
    const ctx = canvas.getContext("2d")!;
    ctx.scale(scale, scale);
    ctx.fillStyle = body.backgroundColor || "#f5f1e8";
    ctx.fillRect(0, 0, w + pad * 2, h + head + pad * 2);
    const display = getComputedStyle(document.documentElement).getPropertyValue("--font-display").trim() || "Georgia, serif";
    ctx.fillStyle = body.color || "#1d1b18";
    ctx.font = `400 22px ${display}`;
    ctx.textBaseline = "top";
    ctx.fillText(opts.title, pad, pad);
    if (opts.subtitle) {
      ctx.globalAlpha = 0.6;
      ctx.font = `400 13px ${body.fontFamily}`;
      ctx.fillText(opts.subtitle, pad, pad + 30);
      ctx.globalAlpha = 1;
    }
    ctx.drawImage(img, pad, pad + head, w, h);
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/png"));
    if (!blob) throw new Error("Could not encode the PNG");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = opts.filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  } finally {
    URL.revokeObjectURL(url);
  }
}
