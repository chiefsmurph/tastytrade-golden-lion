import { emitSecretLog } from "~/strategy/secret";

// Operational event notifications. The single sink today is the live secret
// socket (bare-string "log" event); the wrapper exists so a second sink (HTTP
// webhook, etc.) can be added here without touching any call site. Fire-and-
// forget and non-throwing by design — notifications must never affect trading.
export type NotifyEventType =
  | "cycle-exception"
  | "hard-risk-close"
  | "position-closed"
  | "position-built"
  | "cancel-orders-failed";

// Severity so the receiver can route/color without parsing the message.
//   ERROR — something broke.
//   WARN  — anomaly worth a look, not a failure.
//   INFO  — expected activity fired as designed (a close, a position building
//           out); would be noise if flagged as an error.
const EVENT_SEVERITY: Record<NotifyEventType, "ERROR" | "WARN" | "INFO"> = {
  "cycle-exception": "ERROR",
  "cancel-orders-failed": "ERROR",
  "hard-risk-close": "INFO",
  "position-closed": "INFO",
  "position-built": "INFO",
};

export function notifyEvent(type: NotifyEventType, message: string): void {
  emitSecretLog(`${EVENT_SEVERITY[type]} [${type}] ${message}`);
}
