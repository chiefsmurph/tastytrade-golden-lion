export interface SecretSourcePosition {
  ticker?: string;
  buyWeight?: number;
  daytradeScore?: number;
  isBuyEligible?: boolean | string | number;
  isQualityToBuy?: boolean | string | number;
  returnPerc?: number;
  superRecScore?: number;
  distanceToAsk?: number;
  percentOfBalance?: number;
  isAboveMinSin?: boolean | string | number;
  isAboveMinSis?: boolean | string | number;
  isAboveMinStab?: boolean | string | number;
  isInBssRange?: boolean | string | number;
  isAboveMinPsWordPerc?: boolean | string | number;
  isInZScoreRange?: boolean | string | number;
  isClearedToBuy?: boolean | string | number;
  isAboveMinBuyWeight?: boolean | string | number;
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
