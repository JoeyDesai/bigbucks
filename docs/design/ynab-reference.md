# YNAB layout reference (studied read-only, 2026-10-22)

The household is used to YNAB. The redesign should feel like a near one-to-one of YNAB's web app, with our own name, logo, icons and per-user accent color. Every amount below is a made-up example; screenshots of a real budget never go in the repo (`fixtures/private/` is gitignored).

## Global
- Font: **Figtree** (sans), 16px base, text `#191818`. Light theme: white content area.
- Left sidebar: **navy `#1C1F58`**, 260px wide, white text. Collapsible (toggle bottom-right of sidebar).
  - Top: budget name ("My Budget") with a small logo and the user's email under it, plus a caret menu.
  - Nav items with icons: **Plan**, **Reflect**, **All Accounts**. Active item = lighter rounded highlight (indigo/blue tint) with white text.
  - Account sections: collapsible headings **CASH** and **CREDIT** with a section total right-aligned (credit total shown in a small red rounded badge when negative). Each account row: dot (green/gray = connection status), name (truncated), balance right-aligned (negative balances in a red rounded badge), and a cleared/sync icon (check mark).
  - **CLOSED** collapsible section. Buttons: **Add Account**, **Bank Connections** (outlined, full width, on navy).
- Pills are a core part of YNAB's look: rounded-full colored pills for Available amounts, Ready to Assign, filter chips. They are wanted here (this overrides the old "no pills" rule for this app).

## Plan (budget) screen
- **Header row**: month switcher (circle chevron buttons, "Oct 2026" bold with a dropdown caret, "Enter a note..." under it). Center: the **Ready to Assign** block — a large rounded rectangle, bright green background `~#C4EB8A` when positive (gray at 0, red when negative), big bold amount, "Ready to Assign" label, and a dark-green **Assign ▾** button inside it.
- **Filter chips** row: All (selected = outlined/blue tint), "⚠ 3 Overspent" (red tint with count), Underfunded, Overfunded, Money Available, Snoozed.
- **Toolbar**: "+ Category Group", Undo, Redo, Recent Moves (blue text links with icons); right side a compact/expanded row-density toggle.
- **Table** columns: checkbox · CATEGORY · ASSIGNED · ACTIVITY · AVAILABLE (uppercase small gray headers).
  - Group rows: light gray background, bold name, collapse chevron, group totals in the three columns.
  - Category rows: checkbox, emoji/icon + name; **under the name a thin target progress bar** spanning the name column (green when funded, red segment when overspent, striped/light when partial); target status text right-aligned above the bar in small gray: "Funded", "Fully Spent", "Funded. Spent $41.80 of $45.00", "Overspent. $318.40 of $290.00".
  - **Available pill**: green pill with a check-circle icon when funded/target met; plain green pill when positive; gray pill "$0.00" when zero; **yellow pill with a card icon** for credit overspending; red pill for cash overspending / negative.
  - "Uncategorized Transactions" row pinned at the very top with a red pill.
  - "Credit Card Payments" group second; its Available column header shows "PAYMENT" with the total.
  - "Hidden Categories" row at the bottom; clicking shows a popover listing hidden categories by group ("Click to unhide a category").
- **Right inspector** (~300px, light gray background `#F4F4F6`-ish, white rounded cards):
  - With nothing selected: "October's Summary" card (Left Over from Last Month, Assigned in October, Activity, Available), "Cost to Be Me" (October's Targets amount, "Enter your expected income" button), "Auto-Assign >" card, "Assigned in Future Months" card.
  - With a category selected: category name + Available Balance; breakdown (Cash Left Over From Last Month, Assigned This Month, Cash Spending, Credit Spending); **Target** card ("Set Aside Another $45.00 Each Month", "By the End of the Month", "You've met your target!", a progress ring, Amount to Assign This Month / Assigned So Far / To Go, Edit Target, Snooze); Auto-Assign card; Notes card.
- Selecting a row (checkbox or row click) highlights it light blue and puts the Assigned cell into an inline editable input.

## All Accounts (register)
- Top banner (light indigo): "ⓘ 12 new transactions to approve or categorize." with a **View** button.
- Title "All Accounts"; balance strip: Cleared Balance + Uncleared Balance = Working Balance (big numbers, green for positive).
- Toolbar: "+ Add Transaction", "File Import", Undo, Redo; right: "View ▾" and a search box "Search All Accounts".
- Table columns: checkbox · flag · (memo/attachment icons) · ACCOUNT · DATE ▾ · PAYEE · CATEGORY · MEMO · OUTFLOW · INFLOW · cleared "C" circle (green when cleared).
- Collapsible "Pending Transactions" section at top (beige band).
- Category cell shows "Group: emoji Category"; uncategorized rows show a **yellow pill "This needs a category"**.
- Unapproved rows have a blue dot/“i” marker on the left.

## Reflect (reports)
- Top tabs: Spending Breakdown · Spending Trends · Net Worth · Income v Expense · Age of Money.
- Spending Breakdown: month selector chip, "All Categories ▾", "All Accounts ▾"; big white card with "Total Spending $X", a large donut (colored segments, leader-line labels "Name $X (22%)"), Categories/Groups toggle; right panel list: icon + name, colored bar, percent, amount.

## Mobile (YNAB iOS app conventions to mirror)
- Bottom tab bar: Plan, Spending/Accounts, Add (+ prominent center), Reflect, Settings-ish. Plan is a list of groups with category rows showing the Available pill on the right; tapping a row opens a sheet with Assigned editing and the target. Ready to Assign banner at top in the same green.

## Our customizations
- Own name + logo (not YNAB, not "Homebase").
- **Per-user accent color**: Alex = blue, Sam = pink. Accent drives active nav, selection highlight, links, primary buttons, focus rings. Semantic money colors (green/yellow/red pills) stay the same for both.
- **SVG category icons** instead of emoji (lucide icon keys stored per category; tinted with the group color or accent).
- Light theme by default; dark optional.
