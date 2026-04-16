/**
 * Barrel for the router layer.
 */

export type {
  Attachment,
  Envelope,
  EnvelopeMessage,
  EnvelopeUser,
  RouteDecision,
  SessionScope,
  Source,
  Trigger,
} from "./envelope";
export { sessionKeyFor, type SessionKeyInput } from "./session-key";
export { checkAuth, type AuthDecision, type AuthPolicy } from "./auth";
export {
  route,
  type ChannelPolicy,
  type RouteEnv,
  type RoutedEnvelope,
} from "./route";
