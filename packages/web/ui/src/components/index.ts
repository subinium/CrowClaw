/**
 * Issue #175: Barrel file for components that the app shell wires explicitly
 * (vs. side-effect-imported in `main.ts`). The DEMO badge needs a typed import
 * so the orchestrator can read `.active` / `.connectHref` from app.ts.
 *
 * Issue #178: re-export the command-palette element so `lib/keyboard.ts`
 * (and any other consumer) gets a typed handle without poking the file
 * path directly. The side-effect import below also guarantees the
 * `<crowclaw-command-palette>` tag is registered before app.ts boots.
 *
 * Issue #177: re-export the connection status pill (`<crowclaw-status-pill>`).
 * The orchestrator inserts the element into the header — this barrel just
 * makes sure the custom element is registered and the typed helpers
 * (`aggregateStatus`, action event names) are importable.
 */
export { CrowClawDemoBadge } from './demo-badge.js';
import './demo-badge.js';

export { CrowClawCommandPalette } from './command-palette.js';
import './command-palette.js';

export {
  CrowClawStatusPill,
  aggregateStatus,
  STATUS_PILL_ACTIONS,
  STATUS_PILL_REFRESH_EVENT,
  STATUS_PILL_EVENTBUS_BRIDGE_EVENT,
} from './status-pill.js';
export type {
  StatusColor,
  SubStatus,
  AggregateStatus,
  DiagnosticsResponse,
} from './status-pill.js';
import './status-pill.js';

/**
 * Issues #193, #194, #195 — session-action UI components shipped in v0.7.0.
 * Side-effect imports register the custom elements so chat-view can use the
 * tags directly. Public types are re-exported so views can pass typed
 * `parent` / `CheckpointInfo` props without reaching into individual files.
 */
export { CrowClawSteerComposer } from './steer-composer.js';
import './steer-composer.js';

export { CrowClawForkModal } from './fork-modal.js';
export type { ForkParentInfo } from './fork-modal.js';
import './fork-modal.js';

export { CrowClawCheckpointPanel } from './checkpoint-panel.js';
export type { CheckpointInfo } from './checkpoint-panel.js';
import './checkpoint-panel.js';

/**
 * Issues #179, #180 — observability components shipped in v0.7.0.
 * Side-effect imports register the custom elements so the chat-view
 * orchestrator can mount `<crowclaw-tool-call-trace>` between assistant
 * messages and `<crowclaw-memory-stream>` in the sidebar. Public types
 * are re-exported so the orchestrator can build typed entry/event arrays
 * from the runtime EventBus payloads.
 */
export { CrowClawToolCallTrace } from './tool-call-trace.js';
export type { ToolTraceStatus, ToolTraceEntry } from './tool-call-trace.js';
import './tool-call-trace.js';

export { CrowClawMemoryStream } from './memory-stream.js';
export type { MemoryEventType, MemoryStreamEvent } from './memory-stream.js';
import './memory-stream.js';

/**
 * v0.8.0 (#231) — `<crowclaw-reasoning-block>`. Renders Hermes-style
 * `<plan>` / `<reasoning>` / `<reflection>` / `<thinking>` regions inline
 * inside an assistant message. The chat-view orchestrator mounts one block
 * per parsed `ReasoningBlock` and one live block during streaming (driven
 * by the new `reasoning_start` / `reasoning_delta` / `reasoning_end` SSE
 * events).
 */
export { CrowClawReasoningBlock } from './reasoning-block.js';
import './reasoning-block.js';

/**
 * v0.8.1 (#246, #247, #248) — UX live wave component foundation.
 *
 * Six new primitives that the view-migration agents consume in parallel:
 *   - <crowclaw-button>          — variants/sizes/loading
 *   - <crowclaw-status-dot>      — running/ok/warn/error/idle/paused
 *   - <crowclaw-icon>            — inline SVG icon set
 *   - <crowclaw-skeleton-line / -card / -list> — shimmer placeholders
 *   - <crowclaw-inspector-rail>  — right-side rail with three tabbed slots
 *   - <crowclaw-shortcut-help>   — searchable shortcut modal (data from A7)
 *
 * Side-effect imports register the custom elements; named exports give the
 * orchestrator typed handles and let public types travel with the tag.
 */
export { CrowClawButton } from './button.js';
export type { ButtonVariant, ButtonSize } from './button.js';
import './button.js';

export { CrowClawStatusDot } from './status-dot.js';
export type { StatusDotStatus, StatusDotSize } from './status-dot.js';
import './status-dot.js';

export { CrowClawIcon } from './icon.js';
import './icon.js';

export {
  CrowClawSkeletonLine,
  CrowClawSkeletonCard,
  CrowClawSkeletonList,
} from './skeleton.js';
import './skeleton.js';

export { CrowClawInspectorRail } from './inspector-rail.js';
import './inspector-rail.js';

export { CrowClawShortcutHelp } from './shortcut-help.js';
export type { ShortcutBinding } from './shortcut-help.js';
import './shortcut-help.js';

/**
 * v0.8.4 (#197) — `<crowclaw-persona-pill>`. Header switcher that lists every
 * registered persona with a Preview affordance. Side-effect import keeps the
 * tag registered before the app shell mounts; named exports make the pure
 * formatter helpers reachable from the focused unit tests in
 * `tests/app-header-controls.test.ts`.
 */
export {
  CrowClawPersonaPill,
  personaPillLabel,
  sampleGreetingFor,
} from './persona-pill.js';
import './persona-pill.js';

