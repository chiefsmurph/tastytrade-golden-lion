import TastytradeClient from "@tastytrade/api";
import { config } from "dotenv";
import type { TypedOrderService } from "./tastytrade-order-service";
import type { getBidAskForSymbol as GetBidAskForSymbol, getUnderlyingPrice as GetUnderlyingPrice } from "./market-data";
import type { fetchOptionChain as FetchOptionChain, fetchOptionChainWithVolume as FetchOptionChainWithVolume } from "./option-service";
import type {
  CurrentPosition,
  TastytradeCustomerAccountResource,
  TastytradeOptionChains,
  TastytradeAccountBalance,
  TastytradeCurrentPosition,
} from "./types";

config();

const rawTastytradeApi = new TastytradeClient({
  baseUrl: process.env.CORE_BASE_URL as string,
  accountStreamerUrl: "wss://streamer.cert.tastyworks.com/streamer",
  refreshToken: process.env.CORE_API_REFRESH_TOKEN as string,
  clientSecret: process.env.CORE_API_CLIENT_SECRET as string,
  oauthScopes: ["read", "trade"],
});

type RawTastytradeClient = InstanceType<typeof TastytradeClient>;

type TypedAccountsAndCustomersService = {
  getCustomerAccounts(): Promise<TastytradeCustomerAccountResource[]>;
} & RawTastytradeClient["accountsAndCustomersService"];

type TypedBalancesAndPositionsService = {
  getPositionsList(accountNumber: string): Promise<CurrentPosition[]>;
  getAccountBalanceValues(accountNumber: string): Promise<TastytradeAccountBalance>;
} & RawTastytradeClient["balancesAndPositionsService"];

type TypedInstrumentsService = {
  getNestedOptionChain(symbol: string): Promise<TastytradeOptionChains>;
} & RawTastytradeClient["instrumentsService"];

type TypedOrderServiceWithRaw = TypedOrderService & RawTastytradeClient["orderService"];

export interface JohnsService {
  fetchOptionChain: (
    ...args: Parameters<typeof FetchOptionChain>
  ) => ReturnType<typeof FetchOptionChain>;
  fetchOptionChainWithVolume: (
    ...args: Parameters<typeof FetchOptionChainWithVolume>
  ) => ReturnType<typeof FetchOptionChainWithVolume>;
  getBidAskForSymbol: (
    ...args: Parameters<typeof GetBidAskForSymbol>
  ) => ReturnType<typeof GetBidAskForSymbol>;
  getUnderlyingPrice: (
    ...args: Parameters<typeof GetUnderlyingPrice>
  ) => ReturnType<typeof GetUnderlyingPrice>;
}

export type TypedTastytradeClient = Omit<
  RawTastytradeClient,
  "accountsAndCustomersService" | "balancesAndPositionsService" | "instrumentsService" | "orderService"
> & {
  accountsAndCustomersService: TypedAccountsAndCustomersService;
  balancesAndPositionsService: TypedBalancesAndPositionsService;
  instrumentsService: TypedInstrumentsService;
  johnsService: JohnsService;
  orderService: TypedOrderServiceWithRaw;
};

const tastytradeApi = rawTastytradeApi as unknown as TypedTastytradeClient;

const rawGetPositionsList =
  tastytradeApi.balancesAndPositionsService.getPositionsList.bind(
    tastytradeApi.balancesAndPositionsService,
  );

const rawGetAccountBalanceValues =
  tastytradeApi.balancesAndPositionsService.getAccountBalanceValues.bind(
    tastytradeApi.balancesAndPositionsService,
  );

tastytradeApi.balancesAndPositionsService.getPositionsList = async (
  accountNumber: string,
) => {
  const positions =
    await rawGetPositionsList(accountNumber) as unknown as TastytradeCurrentPosition[];

  return positions as unknown as CurrentPosition[];
};

tastytradeApi.balancesAndPositionsService.getAccountBalanceValues = async (
  accountNumber: string,
) => {
  const accountBalance =
    await rawGetAccountBalanceValues(accountNumber) as unknown as TastytradeAccountBalance;

  return accountBalance;
};

tastytradeApi.johnsService = {
  async getBidAskForSymbol(...args) {
    const { getBidAskForSymbol } = await import("./market-data");
    return getBidAskForSymbol(...args);
  },
  async getUnderlyingPrice(...args) {
    const { getUnderlyingPrice } = await import("./market-data");
    return getUnderlyingPrice(...args);
  },
  async fetchOptionChain(...args) {
    const { fetchOptionChain } = await import("./option-service");
    return fetchOptionChain(...args);
  },
  async fetchOptionChainWithVolume(...args) {
    const { fetchOptionChainWithVolume } = await import("./option-service");
    return fetchOptionChainWithVolume(...args);
  },
};

export default tastytradeApi;


