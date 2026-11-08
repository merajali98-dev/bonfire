export * from "./types.js";
export * from "./errors.js";

export const EMBER_DECIMALS = 18;
/** yoctoNEAR held per new commitment record and refunded on settlement (0.01 NEAR). */
export const COMMIT_DEPOSIT = "10000000000000000000000";
/** Minimum stoke in yoctoNEAR (0.01 NEAR). */
export const MIN_STOKE = "10000000000000000000000";
export const MIN_MISSIONS = 3;
export const MAX_MISSIONS = 5;
export const MAX_CHECKPOINTS = 12;
export const MAX_TITLE_LEN = 80;
export const MAX_URI_LEN = 256;
