import './styles.css';

// Root app
import './app.js';

// Shared components
import './components/sidebar.js';
import './components/modal.js';
import './components/toast.js';
import './components/toggle-switch.js';
import './components/step-feed.js';
import './components/empty.js';

// v0.7.0 components — registered via @customElement side effects.
import './components/demo-badge.js';     // #175 agent A2
import './components/status-pill.js';    // #177 agent A4
import './components/command-palette.js'; // #178 agent A5 (palette element)

// v0.8.0 — Hermes-parity reasoning-block surface (#231).
import './components/reasoning-block.js';

// Views
// #246 Phase A (v0.8.1): `agent-view.js` was deleted; its content was merged
// into `settings-view.js` under the Agent tab. Bookmarks at `#agent` redirect
// to `#settings` via the hash router in app.ts.
import './views/chat-view.js';
import './views/connect-view.js';
import './views/automate-view.js';
import './views/settings-view.js';
import './views/onboarding-view.js';     // #174 agent A1

// v0.7.0 lib modules — keyboard.js mounts the palette + global Cmd+K via
// app.ts:firstUpdated(); side-effect-importing it here is unnecessary
// (app.ts dynamically imports it) but we list it for discoverability.
//   ./lib/keyboard.js  #178 agent A5
//   ./lib/search.js    #178 agent A5 (palette internals)
