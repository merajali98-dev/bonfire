import type { Audit, CommitmentView, Config, NextRoundTerms, RoundView, U128 } from "@bonfire/protocol";

export const CONTRACT = import.meta.env.VITE_CONTRACT ?? "bonfire-meraj-contract.testnet";
export const RPC_URL = import.meta.env.VITE_RPC ?? "https://rpc.testnet.fastnear.com";
export const EXPLORER_TX = "https://testnet.nearblocks.io/txns/";

class ContractError extends Error {}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** Retries rate limits and network failures. A contract error is an answer, so it is not retried. */
export async function view<T>(method: string, args: object = {}): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt > 0) await sleep(500 * 2 ** attempt);
    try {
      const response = await fetch(RPC_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "bonfire",
          method: "query",
          params: {
            request_type: "call_function",
            finality: "optimistic",
            account_id: CONTRACT,
            method_name: method,
            args_base64: btoa(JSON.stringify(args)),
          },
        }),
      });
      if (response.status === 429 || response.status >= 500) throw new Error(`RPC returned ${response.status}`);
      const body = (await response.json()) as { result?: { result?: number[]; error?: string }; error?: { message?: string } };
      if (body.error || body.result?.error || !body.result?.result) {
        throw new ContractError(body.result?.error ?? body.error?.message ?? `View ${method} failed`);
      }
      return JSON.parse(new TextDecoder().decode(new Uint8Array(body.result.result))) as T;
    } catch (error) {
      if (error instanceof ContractError) throw error;
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("The network did not answer.");
}

export const ACTIVE_PHASES = ["Scheduled", "Backing", "Candle", "AwaitingSelection"];

export interface Snapshot {
  round: RoundView | null;
  terms: NextRoundTerms;
  config: Config;
  audit: Audit;
  minStorage: U128;
}

export async function loadSnapshot(): Promise<Snapshot> {
  const [count, terms, config, audit, bounds] = await Promise.all([
    view<number>("get_round_count"),
    view<NextRoundTerms>("get_next_round_terms"),
    view<Config>("get_config"),
    view<Audit>("audit"),
    view<{ min: U128 }>("storage_balance_bounds"),
  ]);
  let round: RoundView | null = null;
  if (count > 0) {
    const recent = await view<RoundView[]>("get_rounds", { from_index: Math.max(0, count - 5), limit: 5 });
    round = [...recent].reverse().find((r) => ACTIVE_PHASES.includes(r.phase)) ?? recent[recent.length - 1] ?? null;
  }
  return { round, terms, config, audit, minStorage: bounds.min };
}

export interface Holdings {
  registered: boolean;
  balance: U128;
  ash: U128;
  faucetNextMs: number;
  commitments: CommitmentView[];
}

export async function loadHoldings(accountId: string): Promise<Holdings> {
  const [storage, balance, ash, faucetNextMs, commitments] = await Promise.all([
    view<object | null>("storage_balance_of", { account_id: accountId }),
    view<U128>("ft_balance_of", { account_id: accountId }),
    view<U128>("get_ash", { account_id: accountId }),
    view<number>("get_faucet_next_ms", { account_id: accountId }),
    view<CommitmentView[]>("get_commitments_of", { account_id: accountId }),
  ]);
  return { registered: storage !== null, balance, ash, faucetNextMs, commitments };
}
