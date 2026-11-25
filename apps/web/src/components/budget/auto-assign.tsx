import type { ActionMenuItem } from "@/components/ui/ActionMenu";

/** Auto-Assign options (spec §6.6) as ActionMenu items. */
export const AUTO_ASSIGN_OPTIONS = [
  { id: "underfunded", label: "Underfunded", description: "Fund every target that still needs money" },
  { id: "assigned_last_month", label: "Assigned last month", description: "Copy last month’s assignments" },
  { id: "spent_last_month", label: "Spent last month", description: "Assign what was spent last month" },
  { id: "average_assigned", label: "Average assigned", description: "12-month average, excluding this month" },
  { id: "average_spent", label: "Average spent", description: "12-month average spending" },
  { id: "reduce_overfunding", label: "Reduce overfunding", description: "Pull back anything above its target" },
  { id: "reset_available", label: "Reset available", description: "Send Available back to Ready to Assign" },
  { id: "reset_assigned", label: "Reset assigned", description: "Set Assigned to zero" },
] as const;

export function AUTO_ASSIGN_ITEMS(onSelect: (mode: string) => void): ActionMenuItem[] {
  return [
    { type: "heading", id: "h", label: "Auto-Assign" },
    ...AUTO_ASSIGN_OPTIONS.slice(0, 5).map((o) => ({ id: o.id, label: o.label, description: o.description, onSelect: () => onSelect(o.id) })),
    { type: "separator", id: "sep" },
    ...AUTO_ASSIGN_OPTIONS.slice(5).map((o) => ({ id: o.id, label: o.label, description: o.description, onSelect: () => onSelect(o.id), destructive: o.id.startsWith("reset") })),
  ];
}
