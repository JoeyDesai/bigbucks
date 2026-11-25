import { cx } from "@/lib/cx";

/** Shimmering placeholder block. */
export function Skeleton({ className, width, height = 12 }: { className?: string; width?: number | string; height?: number | string }) {
  return <span aria-hidden className={cx("skeleton block", className)} style={{ width, height }} />;
}

export function SkeletonText({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <span aria-hidden className={cx("flex flex-col gap-2", className)}>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} width={i === lines - 1 ? "60%" : "100%"} />
      ))}
    </span>
  );
}

/** Placeholder shaped like budget/category rows. */
export function SkeletonRows({ rows = 6, className }: { rows?: number; className?: string }) {
  return (
    <div role="status" aria-label="Loading" className={cx("divide-y divide-rule", className)}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-4 py-3.5">
          <div className="flex-1 space-y-2">
            <Skeleton width={`${45 + ((i * 17) % 35)}%`} height={13} />
            <Skeleton width="70%" height={3} />
          </div>
          <Skeleton width={64} height={13} />
          <Skeleton width={72} height={13} />
        </div>
      ))}
      <span className="sr-only">Loading</span>
    </div>
  );
}
