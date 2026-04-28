/**
 * Barrel re-export for view components.
 *
 * The orchestrator (`app.ts`) imports view registrations through this
 * file so that adding a new view (e.g. the first-run onboarding wizard
 * in #174) is a single edit here rather than a fan-out across the app.
 */

export {
  CrowClawOnboarding,
  shouldShowOnboarding,
  initialStepFromStatus,
  validateApiKey,
  type OnboardingStatus,
  type ProviderId,
} from './onboarding-view.js';
