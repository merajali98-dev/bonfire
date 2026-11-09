import type { Audit, CommitmentView, Config, NextRoundTerms, RoundView, U128 } from "@bonfire/protocol";

export const CONTRACT = import.meta.env.VITE_CONTRACT ?? "bonfire-meraj-contract.testnet";
export const RPC_URL = import.meta.env.VITE_RPC ?? "https://rpc.testnet.fastnear.com";
export const EXPLORER_TX = "https://testnet.nearblocks.io/txns/";

class ContractError extends Error {}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** One RPC query. Retries rate limits and network failures; an RPC or contract error is an answer, so it is not retried. */
async function query<T>(params: Record<string, unknown>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt > 0) await sleep(500 * 2 ** attempt);
    try {
      const response = await fetch(RPC_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "bonfire", method: "query", params: { finality: "optimistic", ...params } }),
      });
      if (response.status === 429 || response.status >= 500) throw new Error(`RPC returned ${response.status}`);
      const body = (await response.json()) as { result?: T & { error?: string }; error?: { message?: string } };
      if (body.error || !body.result || body.result.error) throw new ContractError(body.result?.error ?? body.error?.message ?? "RPC query failed");
      return body.result;
    } catch (error) {
      if (error instanceof ContractError) throw error;
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("The network did not answer.");
}

export async function view<T>(method: string, args: object = {}, contract: string = CONTRACT): Promise<T> {
  const result = await query<{ result?: number[] }>({
    request_type: "call_function",
    account_id: contract,
    method_name: method,
    args_base64: btoa(JSON.stringify(args)),
  });
  if (!result.result) throw new ContractError(`View ${method} failed`);
  return JSON.parse(new TextDecoder().decode(new Uint8Array(result.result))) as T;
}

/** The contract account itself: its code hash and how many access keys can sign for it. */
export async function loadAccountFacts(): Promise<{ codeHash: string; accessKeys: number }> {
  const [account, keys] = await Promise.all([
    query<{ code_hash: string }>({ request_type: "view_account", account_id: CONTRACT }),
    query<{ keys: unknown[] }>({ request_type: "view_access_key_list", account_id: CONTRACT }),
  ]);
  return { codeHash: account.code_hash, accessKeys: keys.keys.length };
}

/** Pages through a view that takes from_index and limit until a short page comes back. */
export async function viewAll<T>(method: string, pageSize = 50): Promise<T[]> {
  const all: T[] = [];
  for (;;) {
    const page = await view<T[]>(method, { from_index: all.length, limit: pageSize });
    all.push(...page);
    if (page.length < pageSize) return all;
  }
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
  rounds: Record<number, RoundView>;
  readAt: number;
}

export async function loadHoldings(accountId: string): Promise<Holdings> {
  const [storage, balance, ash, faucetNextMs, commitments] = await Promise.all([
    view<object | null>("storage_balance_of", { account_id: accountId }),
    view<U128>("ft_balance_of", { account_id: accountId }),
    view<U128>("get_ash", { account_id: accountId }),
    view<number>("get_faucet_next_ms", { account_id: accountId }),
    view<CommitmentView[]>("get_commitments_of", { account_id: accountId }),
  ]);
  const ids = [...new Set(commitments.map((c) => c.round_id))];
  const found = await Promise.all(ids.map((round_id) => view<RoundView | null>("get_round", { round_id })));
  const rounds: Record<number, RoundView> = {};
  found.forEach((round) => {
    if (round) rounds[round.round.id] = round;
  });
  return { registered: storage !== null, balance, ash, faucetNextMs, commitments, rounds, readAt: Date.now() };
}
