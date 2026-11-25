import { Archive, Bell, Bot, Brain, FileUp, Landmark, Link2, ListChecks, Store, Tags, Target, Users, type LucideIcon } from "lucide-react";

/** Icon per Settings section slug. */
export const SECTION_ICONS: Record<string, LucideIcon> = {
  connections: Link2,
  accounts: Landmark,
  categories: Tags,
  targets: Target,
  rules: ListChecks,
  payees: Store,
  memory: Brain,
  notifications: Bell,
  imports: FileUp,
  ai: Bot,
  users: Users,
  backups: Archive,
};
