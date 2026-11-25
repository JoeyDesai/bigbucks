"use client";
import { categoryLabel } from "@/lib/category-icons";
import type { CategoryOption, CategoryVM } from "@/lib/view-models";
import type { ScheduledVM } from "@/server/queries/scheduled";
import { Sheet } from "@/components/ui/Sheet";
import { CategoryDetail } from "./CategoryDetail";

export interface CategorySheetProps {
  month: string;
  category: CategoryVM | null;
  groupName?: string;
  onClose: () => void;
  categoryOptions: CategoryOption[];
  recentCategoryIds: string[];
  onAssign: (id: string, value: bigint) => void;
  onAutoAssign: (mode: string) => void;
  onMove: (fromId: string, toId: string, amount: bigint) => void;
  /** A non-assignment change (target, note, icon) finished: show its Undo toast. */
  onChanged: (message: string, operationId: string | null) => void;
  onError: (message: string) => void;
  /** Scheduled transactions; the ones touching this category are listed as upcoming. */
  scheduled?: ScheduledVM[];
  isHidden?: boolean;
  onSetHidden?: (hidden: boolean) => void;
}

/** Phone bottom sheet for a category (YNAB iOS): assign, target, move, notes, recent activity. */
export function CategorySheet({ category, onClose, ...rest }: CategorySheetProps) {
  return (
    <Sheet open={!!category} onClose={onClose} title={category ? categoryLabel(category.name) : ""} tall>
      {category && <CategoryDetail {...rest} category={category} variant="sheet" />}
    </Sheet>
  );
}
