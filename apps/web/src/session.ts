/** One signing interface for both a connected wallet and a browser-held guest key. */
import type { NearConnector } from "@hot-labs/near-connect";
import { parseErrorCode, ERROR_MESSAGES } from "@bonfire/protocol";
import { CONTRACT, RPC_URL } from "./chain";

// NEAR charges prepaid gas up front, about 0.1 NEAR for 100 TGas, which a new account can't
// cover. The heaviest action this app sends burns about 4 TGas at the worst case.
const GAS = 30_000_000_000_000n;
const GUEST_KEY = "bonfire.guest.v1";

export interface Session {
  kind: "wallet" | "guest";
  accountId: string;
  label: string;
  call(method: string, args: object, depositYocto: bigint): Promise<string | null>;
  signOut(): Promise<void>;
}

export function explain(error: unknown): string {
  const text = error instanceof Error ? error.message : typeof error === "string" ? error : JSON.stringify(error);
  const code = parseErrorCode(text ?? "");
  if (code) return ERROR_MESSAGES[code];
  if (/not have enough balance|NotEnoughBalance|LackBalance/i.test(text ?? "")) {
    return "This account doesn't have enough test NEAR to pay for the transaction. Add some to it, or start as a guest instead.";
  }
  if (/reject|cancel|denied|closed/i.test(text ?? "")) return "The transaction was not approved.";
  return text || "Something went wrong.";
}

// ------------------------------------------------------------------ wallet

let connector: NearConnector | null = null;

async function getConnector(): Promise<NearConnector> {
  if (connector) return connector;
  const { NearConnector } = await import("@hot-labs/near-connect");
  connector = new NearConnector({
    network: "testnet",
    features: { signAndSendTransaction: true, testnet: true },
    // MyNearWallet announced its shutdown; the others cannot serve a stranger on a phone here.
    excludedWallets: ["mynearwallet", "near-cli", "ledger", "ethereum-wallets", "wallet-connect"],
  });
  return connector;
}

interface FinalOutcome {
  status?: unknown;
  transaction?: { hash?: string };
  transaction_outcome?: { id?: string };
}

function walletSession(active: NearConnector, accountId: string, walletName: string): Session {
  return {
    kind: "wallet",
    accountId,
    label: walletName,
    async call(method, args, depositYocto) {
      const wallet = await active.wallet();
      const outcome = (await wallet.signAndSendTransaction({
        network: "testnet",
        signerId: accountId,
        receiverId: CONTRACT,
        actions: [{ type: "FunctionCall", params: { methodName: method, args, gas: GAS.toString(), deposit: depositYocto.toString() } }],
      })) as unknown as FinalOutcome;
      if (outcome.status && typeof outcome.status === "object" && "Failure" in outcome.status) {
        throw new Error(JSON.stringify(outcome.status));
      }
      return outcome.transaction?.hash ?? outcome.transaction_outcome?.id ?? null;
    },
    async signOut() {
      await active.disconnect();
    },
  };
}

export async function connectWallet(): Promise<Session> {
  const active = await getConnector();
  const wallet = await active.connect();
  const accounts = await wallet.getAccounts();
  const accountId = accounts[0]?.accountId;
  if (!accountId) throw new Error("The wallet did not share an account.");
  return walletSession(active, accountId, wallet.manifest.name);
}

export async function restoreWallet(): Promise<Session | null> {
  try {
    const active = await getConnector();
    const { wallet, accounts } = await active.getConnectedWallet();
    const accountId = accounts[0]?.accountId;
    return accountId ? walletSession(active, accountId, wallet.manifest.name) : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ guest

interface StoredGuest {
  accountId: string;
  secretKey: string;
}

function readGuest(): StoredGuest | null {
  try {
    const raw = localStorage.getItem(GUEST_KEY);
    return raw ? (JSON.parse(raw) as StoredGuest) : null;
  } catch {
    return null;
  }
}

function guestSession(guest: StoredGuest): Session {
  return {
    kind: "guest",
    accountId: guest.accountId,
    label: "Guest account",
    async call(method, args, depositYocto) {
      const { Account } = await import("near-api-js");
      const account = new Account(guest.accountId, RPC_URL, guest.secretKey as `ed25519:${string}`);
      const response = await account.callFunctionRaw({ contractId: CONTRACT, methodName: method, args: args as Record<string, unknown>, deposit: depositYocto, gas: GAS });
      return response.transaction.hash;
    },
    async signOut() {
      try {
        localStorage.removeItem(GUEST_KEY);
      } catch {
        // Nothing stored to clear.
      }
    },
  };
}

export function restoreGuest(): Session | null {
  const guest = readGuest();
  return guest ? guestSession(guest) : null;
}

export async function createGuest(): Promise<Session> {
  const { KeyPair } = await import("near-api-js");
  const keyPair = KeyPair.fromRandom("ed25519");
  const response = await fetch("/api/guest", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ publicKey: keyPair.getPublicKey().toString() }),
  });
  const body = (await response.json().catch(() => ({}))) as { accountId?: string; error?: string };
  if (!response.ok || !body.accountId) throw new Error(body.error ?? "Guest accounts are unavailable right now.");
  const guest = { accountId: body.accountId, secretKey: keyPair.toString() };
  try {
    localStorage.setItem(GUEST_KEY, JSON.stringify(guest));
  } catch {
    // Private browsing: the guest lasts for this page only.
  }
  return guestSession(guest);
}
