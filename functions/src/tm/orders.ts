import { TmApiError, type CreateOrderRequest, type OrderStatus, type TmClient, type TmOrder } from "./client.js";
import type { SignerKey } from "./keys.js";
import { stampAll } from "./signer.js";

const FINAL: ReadonlySet<OrderStatus> = new Set(["complete", "filled", "failed", "canceled"]);

export class OrderNotCreatedError extends Error {
  constructor(public quote: unknown) {
    super(`order not created: ${JSON.stringify((quote as { issues?: unknown })?.issues ?? quote)}`);
  }
}

export interface PlaceOrderOptions {
  pollIntervalMs?: number;
  timeoutMs?: number;
  retryStaleQuote?: boolean;
}

// create → (sign + execute when payloads are returned) → poll until final.
// Paper (UAT) settles during create and returns no payloads, so an empty payloads array means "already submitted".
export async function placeOrder(
  client: TmClient,
  signer: SignerKey,
  userId: string,
  order: CreateOrderRequest,
  opts: PlaceOrderOptions = {},
): Promise<TmOrder> {
  const { pollIntervalMs = 2000, timeoutMs = 60_000, retryStaleQuote = true } = opts;

  const created = await client.createOrder(userId, order);
  if (!created.order_id) throw new OrderNotCreatedError(created.quote);

  if (created.payloads?.length) {
    try {
      await client.executeOrder(userId, created.order_id, stampAll(created.payloads, signer));
    } catch (err) {
      if (err instanceof TmApiError && err.type === "quote_stale" && retryStaleQuote) {
        return placeOrder(client, signer, userId, order, { ...opts, retryStaleQuote: false });
      }
      // already_submitted means the transaction landed; fall through to read the order.
      if (!(err instanceof TmApiError && err.type === "already_submitted")) throw err;
    }
  } else if (created.status && FINAL.has(created.status)) {
    return client.getOrder(userId, created.order_id);
  }

  // A market order can report "active" for a moment while it executes; only limit and trigger
  // orders genuinely rest on the book.
  const rests = order.type === "limit" || !!order.trigger;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const current = await client.getOrder(userId, created.order_id);
    if (FINAL.has(current.status) || (rests && current.status === "active")) return current;
    if (Date.now() > deadline) return current;
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
}
