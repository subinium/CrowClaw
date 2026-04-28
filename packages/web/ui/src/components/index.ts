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
