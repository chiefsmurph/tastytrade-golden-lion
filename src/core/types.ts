// Shared runtime types used across the project

// Tastytrade HTTP payloads use kebab-case keys. Keep explicit wire types so
// callers can model API responses accurately when needed.
export interface TastytradeAccountBalance {
  "account-number": string;
  "cash-balance": number | string;
  "long-equity-value": number | string;
  "short-equity-value": number | string;
  "long-derivative-value": number | string;
  "short-derivative-value": number | string;
  "long-futures-value": number | string;
  "short-futures-value": number | string;
  "long-futures-derivative-value": number | string;
  "short-futures-derivative-value": number | string;
  "long-margineable-value": number | string;
  "short-margineable-value": number | string;
  "margin-equity": number | string;
  "equity-buying-power": number | string;
  "derivative-buying-power": number | string;
  "day-trading-buying-power": number | string;
  "futures-margin-requirement": number | string;
  "available-trading-funds": number | string;
  "maintenance-requirement": number | string;
  "maintenance-call-value": number | string;
  "reg-t-call-value": number | string;
  "day-trading-call-value": number | string;
  "day-equity-call-value": number | string;
  "net-liquidating-value": number | string;
  "cash-available-to-withdraw": number | string;
  "day-trade-excess": number | string;
  "pending-cash": number | string;
  "pending-cash-effect": string | null;
  "long-cryptocurrency-value": number | string;
  "short-cryptocurrency-value": number | string;
  "cryptocurrency-margin-requirement": number | string;
  "unsettled-cryptocurrency-fiat-amount": number | string;
  "unsettled-cryptocurrency-fiat-effect": string | null;
  "closed-loop-available-balance": number | string;
  "equity-offering-margin-requirement": number | string;
  "long-bond-value": number | string;
  "bond-margin-requirement": number | string;
  "snapshot-date": string;
  "reg-t-margin-requirement": number | string;
  "futures-overnight-margin-requirement": number | string;
  "futures-intraday-margin-requirement": number | string;
  "maintenance-excess": number | string;
  "pending-margin-interest": number | string;
  "effective-cryptocurrency-buying-power": number | string;
  "updated-at": string;
  "cash-settle-balance"?: number | string;
  currency?: string;
  "fixed-income-security-margin-requirement"?: number | string;
  "intraday-equities-cash-amount"?: number | string;
  "intraday-equities-cash-effect"?: string | null;
  "intraday-futures-cash-amount"?: number | string;
  "intraday-futures-cash-effect"?: string | null;
  "long-fixed-income-security-value"?: number | string;
  "margin-settle-balance"?: number | string;
  "previous-day-cryptocurrency-fiat-amount"?: number | string;
  "previous-day-cryptocurrency-fiat-effect"?: string | null;
  "sma-equity-option-buying-power"?: number | string;
  "special-memorandum-account-apex-adjustment"?: number | string;
  "special-memorandum-account-value"?: number | string;
  "total-settle-balance"?: number | string;
  "used-derivative-buying-power"?: number | string;
  "buying-power-adjustment"?: number | string;
  "buying-power-adjustment-effect"?: string | null;
  "total-pending-liquidity-pool-rebate"?: number | string;
  "long-index-derivative-value"?: number | string;
  "short-index-derivative-value"?: number | string;
  [key: string]: unknown;
}

export interface TastytradeCurrentPosition {
  "account-number": string;
  symbol: string;
  "instrument-type": string;
  "underlying-symbol"?: string | null;
  quantity: number | string;
  "quantity-direction"?: string | null;
  "close-price"?: number | string | null;
  "average-open-price"?: number | string | null;
  multiplier?: number | string | null;
  "cost-effect"?: string | null;
  "is-suppressed"?: boolean;
  "is-frozen"?: boolean;
  "realized-day-gain"?: number | string | null;
  "realized-today"?: number | string | null;
  "created-at"?: string;
  "updated-at"?: string;
  mark?: number | string | null;
  "mark-price"?: number | string | null;
  "restricted-quantity"?: number | string | null;
  "expires-at"?: string | null;
  "fixing-price"?: number | string | null;
  "deliverable-type"?: string | null;
  "average-yearly-market-close-price"?: number | string | null;
  "average-daily-market-close-price"?: number | string | null;
  "realized-day-gain-effect"?: string | null;
  "realized-day-gain-date"?: string | null;
  "realized-today-effect"?: string | null;
  "realized-today-date"?: string | null;
  [key: string]: unknown;
}

export type CurrentPosition = TastytradeCurrentPosition;

export type InstrumentType = 'Equity' | 'Option' | 'Future' | string;

// Option chain types
export interface TastytradeTickSize {
  threshold?: string;
  value: string;
}

export interface TastytradeDeliverable {
  id: number;
  amount: string;
  'deliverable-type': string;
  description: string;
  'instrument-type': string;
  percent: string;
  'root-symbol': string;
  symbol: string;
}

export interface TastytradeStrike {
  'strike-price': string;
  call?: string;
  'call-streamer-symbol'?: string;
  put?: string;
  'put-streamer-symbol'?: string;
}

export interface TastytradeExpiration {
  'expiration-type': string;
  'expiration-date': string;
  'days-to-expiration': number;
  'settlement-type': string;
  strikes: TastytradeStrike[];
}

export interface TastytradeOptionChain {
  'underlying-symbol': string;
  'root-symbol': string;
  'option-chain-type': string;
  'shares-per-contract': number;
  'tick-sizes'?: TastytradeTickSize[];
  'deliverables'?: TastytradeDeliverable[];
  expirations: TastytradeExpiration[];
}

export type TastytradeOptionChains = TastytradeOptionChain[];

// Volume-augmented variants
export interface TastytradeStrikeWithVolumes extends TastytradeStrike {
  callVolume?: number;
  putVolume?: number;
  volume?: number; // generic fallback
  callIv?: number; // implied volatility for call (decimal, e.g. 1.187 = 118.7%)
  putIv?: number;  // implied volatility for put
}

export interface TastytradeExpirationWithVolumes extends Omit<TastytradeExpiration, 'strikes'> {
  strikes: TastytradeStrikeWithVolumes[];
}

export interface TastytradeOptionChainWithVolumes extends Omit<TastytradeOptionChain, 'expirations'> {
  expirations: TastytradeExpirationWithVolumes[];
}

export type TastytradeOptionChainsWithVolumes = TastytradeOptionChainWithVolumes[];

export interface TastytradeCustomerAccountResource {
  account: TastytradeAccountBalance;
}

export type TastytradeOrderAction =
  | "Allocate"
  | "Buy"
  | "Buy to Close"
  | "Buy to Open"
  | "Sell"
  | "Sell to Close"
  | "Sell to Open";

export type TastytradeInstrumentType =
  | "Cryptocurrency"
  | "Equity"
  | "Equity Option"
  | "Event Contract"
  | "Fixed Income Security"
  | "Future"
  | "Future Option"
  | "Liquidity Pool"
  | string;

export type TastytradeOrderType =
  | "Limit"
  | "Market"
  | "Marketable Limit"
  | "Notional Market"
  | "Stop"
  | "Stop Limit";

export type TastytradeTimeInForce =
  | "Day"
  | "Ext"
  | "Ext Overnight"
  | "GTC"
  | "GTC Ext"
  | "GTC Ext Overnight"
  | "GTD"
  | "IOC";

export interface TastytradeOrderFill {
  "destination-venue"?: string;
  "ext-exec-id"?: string;
  "ext-group-fill-id"?: string;
  "fill-id"?: string;
  "fill-price"?: number;
  "filled-at"?: string;
  quantity?: string | number;
}

export interface TastytradeOrderLeg {
  action: TastytradeOrderAction;
  "instrument-type": TastytradeInstrumentType;
  quantity?: string | number;
  "remaining-quantity"?: string | number;
  symbol: string;
  fills?: TastytradeOrderFill[];
}

export interface TastytradeOrderRuleConditionPriceComponent {
  "instrument-type": TastytradeInstrumentType;
  quantity: string | number;
  "quantity-direction": "Long" | "Short";
  symbol: string;
}

export interface TastytradeOrderRuleCondition {
  id?: string;
  action?: "cancel" | "route" | string;
  comparator?: "gte" | "lte" | string;
  indicator?: "last" | "nat" | string;
  "instrument-type"?: TastytradeInstrumentType;
  "is-threshold-based-on-notional"?: boolean;
  symbol?: string;
  threshold?: number;
  "triggered-at"?: string;
  "triggered-value"?: number;
  "price-components"?: TastytradeOrderRuleConditionPriceComponent[];
}

export interface TastytradeOrderRule {
  "cancel-at"?: string;
  "cancelled-at"?: string;
  "route-after"?: string;
  "routed-at"?: string;
  "order-conditions"?: TastytradeOrderRuleCondition[];
}

export interface TastytradeOrder {
  id: string;
  "account-number"?: string;
  "cancel-user-id"?: string;
  "cancel-username"?: string;
  cancellable?: boolean;
  "cancelled-at"?: string;
  "cancelled-size"?: number;
  "complex-order-id"?: string;
  "complex-order-tag"?: string;
  "contingent-status"?: string;
  editable?: boolean;
  edited?: boolean;
  "external-identifier"?: string;
  "global-request-id"?: string;
  "gtc-date"?: string;
  "in-flight-at"?: string;
  "leg-count"?: string;
  "live-at"?: string;
  "order-type"?: TastytradeOrderType | string;
  "preflight-id"?: string;
  price?: number;
  "price-effect"?: "Credit" | "Debit" | string;
  "received-at"?: string;
  "reject-reason"?: string;
  "replaces-order-id"?: string;
  "replacing-order-id"?: string;
  size?: string;
  source?: string;
  status?: string;
  "stop-trigger"?: string | number;
  "terminal-at"?: string;
  "time-in-force"?: TastytradeTimeInForce | string;
  "underlying-instrument-type"?: TastytradeInstrumentType;
  "underlying-symbol"?: string;
  "updated-at"?: string;
  "user-id"?: string;
  username?: string;
  value?: number;
  "value-effect"?: "Credit" | "Debit" | string;
  legs?: TastytradeOrderLeg[];
  "order-rule"?: TastytradeOrderRule;
}

export interface TastytradeOrderIssue {
  code?: string;
  message?: string;
  "preflight-id"?: string;
  url?: string;
}

export interface TastytradePlacedOrderResponse {
  "buying-power-effect"?: string;
  "closing-fee-calculation"?: string;
  "fee-calculation"?: string;
  order?: TastytradeOrder;
  "complex-order"?: unknown;
  errors?: TastytradeOrderIssue[];
  warnings?: TastytradeOrderIssue[];
  notes?: TastytradeOrderIssue[];
}

export interface OrderRequestLeg {
  action: TastytradeOrderAction;
  "instrument-type": TastytradeInstrumentType;
  quantity?: number;
  symbol: string;
}

export interface OrderRequest {
  "advanced-instructions"?: {
    "strict-position-effect-validation"?: boolean;
  };
  "automated-source"?: boolean;
  "external-identifier"?: string;
  "gtc-date"?: string;
  legs: OrderRequestLeg[];
  "order-type": TastytradeOrderType;
  "partition-key"?: string;
  price?: string | number;
  "price-effect"?: "Credit" | "Debit";
  "preflight-id"?: string;
  source: string;
  "stop-trigger"?: number;
  "time-in-force": TastytradeTimeInForce;
  value?: number;
  "value-effect"?: "Credit" | "Debit";
}
