import type { SignerApi } from "./signer.js";

/** Line-delimited JSON over the child process's stdin/stdout. */
export type SignerMethod = keyof SignerApi;

export interface SignerRequest {
  id: number;
  method: SignerMethod;
  params?: unknown;
}

export type SignerResponse =
  | { id: number; result: unknown }
  | { id: number; error: { message: string; rule: boolean } };

export const SIGNER_METHODS: readonly SignerMethod[] = ["addresses", "hlSignL1", "hlApproveAgent", "solSignTransaction", "hlDepositFromArbitrum"];
