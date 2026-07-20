import tastytradeApi from "./tastytrade-client";
import { recordTastytradeApiCall } from "./api-call-counter";

// Wires API call counting onto the single shared TastytradeHttpClient that
// every SDK service holds (see @tastytrade/api tastytrade-api.js — each
// service is constructed with the same instance), so patching its data verbs
// covers option chains, market metrics, orders, positions, everything, with
// zero call-site edits. generateAccessToken is included because token
// refreshes fire their own axios request to /oauth/token outside the data
// verbs. Lives apart from tastytrade-client.ts and is invoked from the boot
// path (src/index.ts) before any request fires.

type AnyAsyncMethod = (...args: unknown[]) => Promise<unknown>;

const COUNTED_METHODS = [
  "getData",
  "postData",
  "putData",
  "patchData",
  "deleteData",
  "generateAccessToken",
] as const;

const installedClients = new WeakSet<object>();

// Exported for tests: instruments any httpClient-shaped object. Counting is
// observability only — a throwing recorder must never break the request, and
// double-install must never double-count.
export function installApiCallCounting(
  httpClient: Record<string, unknown> | null | undefined,
  record: (url: string) => void = recordTastytradeApiCall,
): boolean {
  if (!httpClient || installedClients.has(httpClient)) return false;
  installedClients.add(httpClient);

  for (const method of COUNTED_METHODS) {
    const raw = httpClient[method];
    if (typeof raw !== "function") continue;

    const bound = (raw as AnyAsyncMethod).bind(httpClient);
    httpClient[method] = (...args: unknown[]) => {
      try {
        record(method === "generateAccessToken" ? "/oauth/token" : String(args[0] ?? ""));
      } catch {}
      return bound(...args);
    };
  }

  return true;
}

export function installTastytradeApiCallCounting(): void {
  try {
    installApiCallCounting(
      (tastytradeApi as unknown as { httpClient?: Record<string, unknown> }).httpClient,
    );
  } catch {}
}
