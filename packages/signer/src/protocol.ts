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

export const SIGNER_METHODS: readonly SignerMethod[] = [
  "addresses",
  "hlSignL1",
  "hlApproveAgent",
  "solSignTransaction",
  "hlDepositFromArbitrum",
  "evmSendTransaction",
  "deriveSignOrder",
  "deriveAuthHeaders",
  "deriveRegisterSessionKey",
  "polySignTypedData",
];

/** JSON can't carry bigints (Polymarket's typed data is full of them), so they travel as {"$bigint": "123"}. */
export function encodeLine(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => (typeof v === "bigint" ? { $bigint: v.toString() } : v));
}

export function decodeLine(line: string): unknown {
  return JSON.parse(line, (_k, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 1 && typeof (v as { $bigint?: unknown }).$bigint === "string"
      ? BigInt((v as { $bigint: string }).$bigint)
      : v,
  );
}
