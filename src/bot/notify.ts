import { emitSecretLog, getSecretSocketStatus } from "~/strategy/secret";

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
  const severity = EVENT_SEVERITY[type];
  emitSecretLog(`${severity} [${type}] ${message}`);

  // Local breadcrumb so the daily EOD check (OPERATIONS §1 / runbook #16) can
  // confirm a notification fired from the bot's own pm2 log, without depending
  // on the secret server's stream. The `sink` flag records whether the socket
  // was connected — i.e. whether the emit above was actually delivered vs.
  // silently dropped. Best-effort and non-throwing, like the emit itself.
  try {
    const sink = getSecretSocketStatus().connected ? "sent" : "no-socket";
    console.log(`[notify] ${severity} ${type} (${sink}) ${message}`);
  } catch {
    // logging must never touch the trading path
  }
}
