// Tokens
export { LensElement, lensBaseStyles } from "./tokens/base.js";

// Types (re-exported from kernel)
export type * from "./mock/types.js";

// Client (re-exported from kernel's lens layer)
export { LensClient } from "./mock/types.js";

// Mock data
export {
  mockProcesses, mockEdges, mockDagNodes, mockBlackboard,
  mockHeuristics, mockDeferrals, mockMetrics, mockEvents,
  mockTerminalLines, mockRuns, mockSnapshot,
} from "./mock/factories.js";

// Primitives
export { LensBadge } from "./primitives/badge.js";
export { LensButton } from "./primitives/button.js";
export { LensInput } from "./primitives/input.js";
export { LensPanel } from "./primitives/panel.js";
export { LensCard } from "./primitives/card.js";
export { LensTable } from "./primitives/table.js";
export { LensTooltip } from "./primitives/tooltip.js";

// Layout
export { LensTopbar } from "./layout/topbar.js";
export { LensBottombar } from "./layout/bottombar.js";
export { LensTabbar } from "./layout/tabbar.js";
export { LensSidebar } from "./layout/sidebar.js";
export { LensSplitLayout } from "./layout/split-layout.js";

// Domain
export { LensConnectionBadge } from "./domain/connection-badge.js";
export { LensNarrativeBar } from "./domain/narrative-bar.js";
export { LensEventFeed } from "./domain/event-feed.js";
export { LensProcessTree } from "./domain/process-tree.js";
export { LensProcessDrawer } from "./domain/process-drawer.js";
export { LensBlackboard } from "./domain/blackboard.js";
export { LensHeuristicCard } from "./domain/heuristic-card.js";
export { LensDeferralCard } from "./domain/deferral-card.js";
export { LensTerminalView } from "./domain/terminal-view.js";
export { LensDagView } from "./domain/dag-view.js";
export { LensMetricsBar } from "./domain/metrics-bar.js";
export { LensCommandPalette } from "./domain/command-palette.js";
export { LensExpandedView } from "./domain/expanded-view.js";

// Compositions
export { LensDashboard } from "./compositions/dashboard.js";
export { LensApp } from "./compositions/app.js";
