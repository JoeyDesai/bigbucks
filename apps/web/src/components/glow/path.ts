/** Smooth SVG paths for charts (monotone cubic interpolation: no overshoot between points). */
export interface Pt {
  x: number;
  y: number;
}

/** Monotone cubic (Fritsch–Carlson) through the points, as an SVG path "M … C …". */
export function monotonePath(pts: readonly Pt[]): string {
  const n = pts.length;
  if (n === 0) return "";
  if (n === 1) return `M${pts[0]!.x},${pts[0]!.y}`;
  const dx: number[] = [];
  const m: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const h = pts[i + 1]!.x - pts[i]!.x || 1e-9;
    dx.push(h);
    m.push((pts[i + 1]!.y - pts[i]!.y) / h);
  }
  const t: number[] = [m[0]!];
  for (let i = 1; i < n - 1; i++) {
    if (m[i - 1]! * m[i]! <= 0) t.push(0);
    else {
      const w1 = 2 * dx[i]! + dx[i - 1]!;
      const w2 = dx[i]! + 2 * dx[i - 1]!;
      t.push((w1 + w2) / (w1 / m[i - 1]! + w2 / m[i]!));
    }
  }
  t.push(m[n - 2]!);
  let d = `M${pts[0]!.x.toFixed(2)},${pts[0]!.y.toFixed(2)}`;
  for (let i = 0; i < n - 1; i++) {
    const p0 = pts[i]!;
    const p1 = pts[i + 1]!;
    const h = dx[i]!;
    d += `C${(p0.x + h / 3).toFixed(2)},${(p0.y + (t[i]! * h) / 3).toFixed(2)} ${(p1.x - h / 3).toFixed(2)},${(p1.y - (t[i + 1]! * h) / 3).toFixed(2)} ${p1.x.toFixed(2)},${p1.y.toFixed(2)}`;
  }
  return d;
}

/** Evenly thin a long series to at most `max` points (always keeps the first and last). */
export function thin<T>(xs: readonly T[], max: number): T[] {
  if (xs.length <= max) return [...xs];
  const out: T[] = [];
  const step = (xs.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) out.push(xs[Math.round(i * step)]!);
  return out;
}
