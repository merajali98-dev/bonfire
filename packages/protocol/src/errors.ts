/** Stable contract error codes (`err::*` in contracts/bonfire/src/lib.rs) with plain-language text. */
export const ERROR_MESSAGES = {
  ERR_NOT_CURATOR: "Only the curator can do this.",
  ERR_NOT_REVIEWER: "Only this round's reviewer can do this.",
  ERR_NOT_CREATOR: "Only the named creator can do this.",
  ERR_NO_ROUND: "That round does not exist.",
  ERR_NO_NOMINATION: "That nomination does not exist.",
  ERR_NO_MISSION: "That mission is not in this round.",
  ERR_INSUFFICIENT_ASH: "This account does not have enough Ash to nominate.",
  ERR_HEARTH_TOO_LOW: "The Hearth does not hold enough NEAR for this budget.",
  ERR_BAD_PARAMS: "The contract refused these parameters.",
  ERR_NOT_BACKING: "This round is not open for backing.",
  ERR_CANDLE_LIT: "The candle is lit: commitments can only be added now.",
  ERR_STILL_BURNING: "Backing has not closed yet.",
  ERR_WRONG_STATUS: "The round is not in the right state for this.",
  ERR_DEADLINE_PASSED: "The deadline for this has passed.",
  ERR_NOT_EXPIRED: "The deadline has not passed yet.",
  ERR_HASH_MISMATCH: "This hash is not the one the creator submitted.",
  ERR_BAD_HASH: "The hash must be 64 lowercase hex characters.",
  ERR_NOT_ACCEPTED: "The work has not been accepted.",
  ERR_NOTHING_TO_SETTLE: "There is nothing to settle for this account in this round.",
  ERR_NOT_SELECTED: "The candle has not been drawn for this round yet.",
  ERR_DEPOSIT: "The attached NEAR deposit is too small.",
  ERR_AMOUNT: "That amount is not available.",
  ERR_FAUCET_COOLDOWN: "This account claimed recently. Try again after the cooldown.",
  ERR_FAUCET_EMPTY: "The faucet pool is empty.",
  ERR_NO_TRANSFER_TO_CONTRACT: "EMBER cannot be sent directly to the contract.",
  ERR_UNREGISTER_BLOCKED: "This account cannot unregister while it has open commitments.",
  ERR_NOT_REGISTERED: "This account is not registered with EMBER yet.",
  ERR_NOMINATION_USED: "That nomination has already been used in a round.",
  ERR_NOT_CONSENTED: "The creator has not consented to this nomination.",
} as const;

export type ErrorCode = keyof typeof ERROR_MESSAGES;

/** Finds the contract error code inside an RPC or wallet failure message. */
export function parseErrorCode(message: string): ErrorCode | null {
  const match = message.match(/ERR_[A-Z_]+/);
  return match && match[0] in ERROR_MESSAGES ? (match[0] as ErrorCode) : null;
}
