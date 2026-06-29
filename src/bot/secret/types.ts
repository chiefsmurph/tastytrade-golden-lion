export interface SecretSourcePosition {
  ticker?: string;
  buyWeight?: number;
  daytradeScore?: number;
  buyEligible?: boolean | string | number;
  returnPerc?: number;
  superRecScore?: number;
  distanceToAsk?: number;
  percentOfBalance?: number;
  isAboveMinSinFloor?: boolean | string | number;
  aboveMinSis?: boolean | string | number;
  isAboveStabMin?: boolean | string | number;
  isClearedToBuy?: boolean | string | number;
  currentlyAboveMinBuyWeight?: boolean | string | number;
  willBuy?: boolean | string | number;
  [key: string]: unknown;
}

export interface SecretTickerRecPick {
  ticker?: string;
  shouldBuy?: boolean | string | number;
  [key: string]: unknown;
}

export interface SecretTickerRecsUpdate {
  picks?: SecretTickerRecPick[] | unknown;
  [key: string]: unknown;
}

export interface SecretDataUpdatePayload {
  positions?: {
    [key: string]: SecretSourcePosition[] | unknown;
  };
  tickerRecs?: SecretTickerRecsUpdate | unknown;
  [key: string]: unknown;
}
