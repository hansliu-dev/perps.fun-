import type { TokenProvider } from "./auth.js";
import type { OrderPayload } from "./signer.js";

export class TmApiError extends Error {
  constructor(
    public status: number,
    public body: { type?: string; message?: string; request_id?: string } | string,
    path: string,
  ) {
    super(`TrueMarkets ${status} on ${path}: ${typeof body === "string" ? body : JSON.stringify(body)}`);
  }

  get type(): string | undefined {
    return typeof this.body === "string" ? undefined : this.body.type;
  }
}

export interface TmWallet {
  address: string;
  chain_family: "solana" | "evm";
}

export interface TmUser {
  user_id: string;
  external_ref_id: string;
  created_at: string;
  wallets: TmWallet[];
}

export interface TmAsset {
  id: string;
  symbol: string;
  chain: string;
  venue: "defi" | "cefi";
  type: "spot" | "perp";
  asset_class?: "crypto" | "stock";
  status: string;
  decimals?: number; // size decimals (matches the venue's order size precision)
  perp?: { funding_rate: string | null; open_interest: string | null; volume_24h: string | null; max_leverage: number | null };
}

export interface CreateOrderRequest {
  asset_id: string;
  side: "buy" | "sell";
  type: "market" | "limit";
  qty: string;
  qty_unit: "base" | "quote";
  price?: string;
  leverage?: number;
  reduce_only?: boolean;
  trigger?: { type: "take_profit" | "stop_loss"; price: string };
}

export type OrderStatus = "initialized" | "pending" | "active" | "cancel_pending" | "complete" | "filled" | "canceled" | "failed";

export interface CreateOrderResponse {
  order_id: string;
  status?: OrderStatus;
  payloads?: OrderPayload[];
  quote?: { issues?: unknown[] } & Record<string, unknown>;
}

export interface TmOrder {
  id?: string;
  order_id?: string;
  status: OrderStatus;
  executed_qty?: string;
  asset_type?: "spot" | "perp";
  failure_reason?: string;
  [k: string]: unknown;
}

export interface TmPosition {
  asset_id: string;
  venue: string;
  symbol: string;
  side: "long" | "short";
  size: string;
  entry_price: string;
  mark_price: string;
  liquidation_price: string | null;
  margin_used: string;
  unrealized_pnl: string;
  return_on_equity: string;
  leverage: number;
}

export interface TmPortfolio {
  total_usd: string;
  balances_usd: string;
  cash_usd: string;
  change_24h_usd: string;
  change_24h_pct: string;
  unrealized_pnl_usd: string;
  realized_pnl_usd: string;
  balances: Array<{ symbol: string; venue: string; total: string; available: string; held: string; stable: boolean; [k: string]: unknown }>;
  positions: TmPosition[];
}

export interface TmBalance {
  asset_id: string;
  symbol: string;
  chain?: string;
  venue: "defi" | "cefi";
  available: string;
  total: string;
  [k: string]: unknown;
}

export type TransferStatus = "awaiting_signature" | "pending" | "completed" | "failed";

export interface TmTransfer {
  id: string;
  status: TransferStatus;
  asset_symbol?: string;
  chain?: string;
  to?: string;
  qty?: string;
  sent?: string;
  received?: string;
  explorer_url?: string;
  payloads?: OrderPayload[];
  [k: string]: unknown;
}

const RETRYABLE = new Set([429, 503]);

export class TmClient {
  constructor(
    private baseUrl: string,
    private tokens: TokenProvider,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  private async request<T>(method: string, path: string, opts: { body?: unknown; onBehalfOf?: string; auth?: boolean } = {}): Promise<T> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (opts.auth !== false) headers.Authorization = `Bearer ${(await this.tokens.get()).accessToken}`;
    if (opts.onBehalfOf) headers["TM-On-Behalf-Of"] = opts.onBehalfOf;

    for (let attempt = 0; ; attempt++) {
      const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      });
      if (res.ok) return (await res.json()) as T;
      if (RETRYABLE.has(res.status) && attempt < 4) {
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
        continue;
      }
      const text = await res.text();
      let body: TmApiError["body"] = text;
      try {
        body = JSON.parse(text);
      } catch {}
      throw new TmApiError(res.status, body, path);
    }
  }

  async organizationId(): Promise<string> {
    return (await this.tokens.get()).organizationId;
  }

  // Idempotent on external_ref_id: 201 creates, 200 returns the existing user; 503 (wallets not ready) is retried.
  async createUser(externalRefId: string, signerPublicKey: string): Promise<TmUser> {
    const org = await this.organizationId();
    return this.request("POST", `/v1/account/organizations/${org}/users`, {
      body: { external_ref_id: externalRefId, signer_public_key: signerPublicKey },
    });
  }

  // Newest first; follows pagination.next_cursor until exhausted.
  async listUsers(): Promise<TmUser[]> {
    const org = await this.organizationId();
    const all: TmUser[] = [];
    let cursor: string | undefined;
    do {
      const qs = new URLSearchParams({ limit: "100", ...(cursor ? { cursor } : {}) });
      const page = await this.request<{ data: TmUser[]; pagination?: { next_cursor?: string } }>("GET", `/v1/account/organizations/${org}/users?${qs}`);
      all.push(...page.data);
      cursor = page.pagination?.next_cursor || undefined;
    } while (cursor);
    return all;
  }

  async getUser(userId: string): Promise<TmUser> {
    const org = await this.organizationId();
    return this.request("GET", `/v1/account/organizations/${org}/users/${userId}`);
  }

  async listAssets(params: { product_type?: string; asset_class?: string } = {}): Promise<TmAsset[]> {
    const qs = new URLSearchParams(params as Record<string, string>).toString();
    const res = await this.request<{ data: TmAsset[] }>("GET", `/v1/gateway/assets${qs ? `?${qs}` : ""}`, { auth: false });
    return res.data;
  }

  createOrder(userId: string, order: CreateOrderRequest): Promise<CreateOrderResponse> {
    return this.request("POST", "/v1/gateway/orders", { body: order, onBehalfOf: userId });
  }

  executeOrder(userId: string, orderId: string, signatures: string[]): Promise<{ status: OrderStatus }> {
    return this.request("POST", `/v1/gateway/orders/${orderId}/execute`, {
      body: { signatures, auth_type: "api_key" },
      onBehalfOf: userId,
    });
  }

  getOrder(userId: string, orderId: string): Promise<TmOrder> {
    return this.request("GET", `/v1/gateway/orders/${orderId}`, { onBehalfOf: userId });
  }

  cancelOrder(userId: string, orderId: string): Promise<{ payloads?: OrderPayload[]; status?: OrderStatus }> {
    return this.request("POST", `/v1/gateway/orders/${orderId}/cancel`, { onBehalfOf: userId });
  }

  executeCancel(userId: string, orderId: string, signatures: string[]): Promise<{ status: OrderStatus }> {
    return this.request("POST", `/v1/gateway/orders/${orderId}/cancel/execute`, {
      body: { signatures, auth_type: "api_key" },
      onBehalfOf: userId,
    });
  }

  async listPositions(userId: string): Promise<TmPosition[]> {
    return (await this.request<{ positions: TmPosition[] }>("GET", "/v1/gateway/positions", { onBehalfOf: userId })).positions;
  }

  getPortfolio(userId: string): Promise<TmPortfolio> {
    return this.request("GET", "/v1/gateway/portfolio", { onBehalfOf: userId });
  }

  async getBalances(userId: string): Promise<TmBalance[]> {
    return (await this.request<{ data: TmBalance[] }>("GET", "/v1/gateway/balances", { onBehalfOf: userId })).data;
  }

  // Same-chain only: the network comes from the asset's chain. Final once the chain confirms it.
  createTransfer(userId: string, body: { asset_id: string; qty: string; to: string }): Promise<TmTransfer> {
    return this.request("POST", "/v1/gateway/transfers", { body: { ...body, qty_unit: "base" }, onBehalfOf: userId });
  }

  executeTransfer(userId: string, transferId: string, signatures: string[]): Promise<TmTransfer> {
    return this.request("POST", `/v1/gateway/transfers/${transferId}/execute`, {
      body: { signatures, auth_type: "api_key" },
      onBehalfOf: userId,
    });
  }

  getTransfer(userId: string, transferId: string): Promise<TmTransfer> {
    return this.request("GET", `/v1/gateway/transfers/${transferId}`, { onBehalfOf: userId });
  }

  // UAT only; production answers 404.
  paperDeposit(userId: string, assetId: string, amount: string, allocate?: boolean): Promise<{ asset_id: string; amount: string; wallet_balance: string; allocation?: { id: string; status: string } }> {
    return this.request("POST", "/v1/gateway/paper/deposits", {
      body: { asset_id: assetId, amount, ...(allocate === undefined ? {} : { allocate }) },
      onBehalfOf: userId,
    });
  }

  paperWithdraw(userId: string, assetId: string, amount: string): Promise<unknown> {
    return this.request("POST", "/v1/gateway/paper/withdrawals", {
      body: { asset_id: assetId, amount },
      onBehalfOf: userId,
    });
  }
}
