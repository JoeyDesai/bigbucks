/**
 * The Big Bucks mark: a front-facing bucket with a buck's head on it and dollar bills sticking out
 * of the top. Rendered from public/icons/mark.svg, which scripts/generate-icons.mjs writes from
 * scripts/buckets-mark.mjs (one source for the in-app mark and the PNG app icons).
 */
export function Mark({ size = 24, className, title }: { size?: number; className?: string; title?: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element -- tiny static SVG; next/image adds nothing here
    <img src="/icons/mark.svg" width={size} height={size} alt={title ?? ""} aria-hidden={title ? undefined : true} className={className} draggable={false} />
  );
}
