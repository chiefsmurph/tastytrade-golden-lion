import { emitSecretLog } from "~/strategy/secret";

// Operational event notifications. The single sink today is the live secret
// socket (bare-string "log" event); the wrapper exists so a second sink (HTTP
// webhook, etc.) can be added here without touching any call site. Fire-and-
// forget and non-throwing by design — notifications must never affect trading.
export type NotifyEventType =
  | "cycle-exception"
  | "hard-risk-close"
  | "cancel-orders-failed";

// Severity so the receiver can route/color without parsing the message. ERROR =
// something broke; INFO = a circuit breaker fired as designed (e.g. the daily
// EOD liquidation, which is expected and would be noise if flagged as an error).
const EVENT_SEVERITY: Record<NotifyEventType, "ERROR" | "INFO"> = {
  "cycle-exception": "ERROR",
  "cancel-orders-failed": "ERROR",
  "hard-risk-close": "INFO",
};

export function notifyEvent(type: NotifyEventType, message: string): void {
  emitSecretLog(`${EVENT_SEVERITY[type]} [${type}] ${message}`);
}
