import { assertNotReadOnly } from "./read-only-accounts";
import type {
  OrderRequest,
  TastytradeOrder,
  TastytradePlacedOrderResponse,
} from "./types";

type RawOrderService = {
  postReconfirmOrder(accountNumber: string, orderId: number): Promise<unknown>;
  replacementOrderDryRun(
    accountNumber: string,
    orderId: number,
    replacementOrder: object,
  ): Promise<unknown>;
  getOrder(accountNumber: string, orderId: number): Promise<unknown>;
  cancelOrder(accountNumber: string, orderId: number): Promise<unknown>;
  cancelComplexOrder(accountNumber: string, orderId: number): Promise<unknown>;
  replaceOrder(
    accountNumber: string,
    orderId: number,
    replacementOrder: object,
  ): Promise<unknown>;
  editOrder(accountNumber: string, orderId: number, order: object): Promise<unknown>;
  getLiveOrders(accountNumber: string): Promise<unknown>;
  getOrders(accountNumber: string, queryParams?: object): Promise<unknown>;
  createOrder(accountNumber: string, order: object): Promise<unknown>;
  createComplexOrder(accountNumber: string, order: object): Promise<unknown>;
  postOrderDryRun(accountNumber: string, order: object): Promise<unknown>;
  getLiveOrdersForCustomer(customerId: string): Promise<unknown>;
  getCustomerOrders(customerId: string, queryParams?: object): Promise<unknown>;
};

export interface TypedOrderService {
  postReconfirmOrder(accountNumber: string, orderId: number): Promise<TastytradePlacedOrderResponse>;
  replacementOrderDryRun(
    accountNumber: string,
    orderId: number,
    replacementOrder: Partial<OrderRequest>,
  ): Promise<TastytradePlacedOrderResponse>;
  getOrder(accountNumber: string, orderId: number): Promise<TastytradeOrder>;
  cancelOrder(accountNumber: string, orderId: number): Promise<TastytradeOrder>;
  cancelComplexOrder(accountNumber: string, orderId: number): Promise<unknown>;
  replaceOrder(
    accountNumber: string,
    orderId: number,
    replacementOrder: Partial<OrderRequest>,
  ): Promise<TastytradeOrder>;
  editOrder(
    accountNumber: string,
    orderId: number,
    order: Partial<OrderRequest>,
  ): Promise<TastytradeOrder>;
  getLiveOrders(accountNumber: string): Promise<TastytradeOrder[]>;
  getOrders(accountNumber: string, queryParams?: object): Promise<TastytradeOrder[]>;
  createOrder(accountNumber: string, order: OrderRequest): Promise<TastytradePlacedOrderResponse>;
  createComplexOrder(accountNumber: string, order: object): Promise<TastytradePlacedOrderResponse>;
  postOrderDryRun(accountNumber: string, order: OrderRequest): Promise<TastytradePlacedOrderResponse>;
  getLiveOrdersForCustomer(customerId: string): Promise<TastytradeOrder[]>;
  getCustomerOrders(customerId: string, queryParams?: object): Promise<TastytradeOrder[]>;
}

export function createTypedOrderService(rawOrderService: RawOrderService): TypedOrderService {
  return {
    async postReconfirmOrder(accountNumber: string, orderId: number) {
      return (await rawOrderService.postReconfirmOrder(
        accountNumber,
        orderId,
      )) as TastytradePlacedOrderResponse;
    },
    async replacementOrderDryRun(
      accountNumber: string,
      orderId: number,
      replacementOrder: Partial<OrderRequest>,
    ) {
      return (await rawOrderService.replacementOrderDryRun(
        accountNumber,
        orderId,
        replacementOrder,
      )) as TastytradePlacedOrderResponse;
    },
    async getOrder(accountNumber: string, orderId: number) {
      return (await rawOrderService.getOrder(accountNumber, orderId)) as TastytradeOrder;
    },
    async cancelOrder(accountNumber: string, orderId: number) {
      return (await rawOrderService.cancelOrder(accountNumber, orderId)) as TastytradeOrder;
    },
    async cancelComplexOrder(accountNumber: string, orderId: number) {
      return rawOrderService.cancelComplexOrder(accountNumber, orderId);
    },
    async replaceOrder(
      accountNumber: string,
      orderId: number,
      replacementOrder: Partial<OrderRequest>,
    ) {
      assertNotReadOnly(accountNumber);
      return (await rawOrderService.replaceOrder(
        accountNumber,
        orderId,
        replacementOrder,
      )) as TastytradeOrder;
    },
    async editOrder(
      accountNumber: string,
      orderId: number,
      order: Partial<OrderRequest>,
    ) {
      return (await rawOrderService.editOrder(accountNumber, orderId, order)) as TastytradeOrder;
    },
    async getLiveOrders(accountNumber: string) {
      return (await rawOrderService.getLiveOrders(accountNumber)) as TastytradeOrder[];
    },
    async getOrders(accountNumber: string, queryParams?: object) {
      return (await rawOrderService.getOrders(accountNumber, queryParams)) as TastytradeOrder[];
    },
    async createOrder(accountNumber: string, order: OrderRequest) {
      assertNotReadOnly(accountNumber);
      return (await rawOrderService.createOrder(
        accountNumber,
        order,
      )) as TastytradePlacedOrderResponse;
    },
    async createComplexOrder(accountNumber: string, order: object) {
      return (await rawOrderService.createComplexOrder(
        accountNumber,
        order,
      )) as TastytradePlacedOrderResponse;
    },
    async postOrderDryRun(accountNumber: string, order: OrderRequest) {
      return (await rawOrderService.postOrderDryRun(
        accountNumber,
        order,
      )) as TastytradePlacedOrderResponse;
    },
    async getLiveOrdersForCustomer(customerId: string) {
      return (await rawOrderService.getLiveOrdersForCustomer(customerId)) as TastytradeOrder[];
    },
    async getCustomerOrders(customerId: string, queryParams?: object) {
      return (await rawOrderService.getCustomerOrders(customerId, queryParams)) as TastytradeOrder[];
    },
  };
}
