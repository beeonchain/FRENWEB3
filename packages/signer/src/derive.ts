import { concat, encodeAbiParameters, getAddress, keccak256, parseUnits, toBytes, toHex, type Hex, type PrivateKeyAccount } from "viem";
import { SignerRuleError } from "./rules.js";

/**
 * Derive (options) signing. Derive orders are "actions" signed over a fixed
 * EIP-712 domain. The signer builds every action itself from a few typed
 * fields, so the engine can never get it to sign a withdrawal or a transfer:
 * the only module it ever names is the trade module, and the only thing the
 * owner key ever signs is registering Fren's own session key with the
 * option-trading scope.
 *
 * Constants are from Derive's official SDK (@derivexyz/derive-ts 3.0.35).
 */

export const DERIVE_MATCHING = "0xeB8d770ec18DB98Db922E9D83260A585b9F0DeAD";
export const DERIVE_TRADE_MODULE = "0xB8D20c2B7a1Ad2EE33Bc50eF10876eD3035b5e7b";
export const DERIVE_SET_SESSION_KEY_MODULE = "0xe330CF64ff6EbF41699aad344Cb21d78db1D2bb6";
const ACTION_TYPEHASH: Hex = "0x4d7a9f27c403ff9c0f19bce61d76d82f9aa29f8d6d4b0c5474607d9770d1af17";
const DOMAIN_TYPEHASH = keccak256(toBytes("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"));

/** Derive v3 settles on Ethereum: mainnet signs for chain 1, testnet for Sepolia. */
export const deriveChainId = (isTestnet: boolean) => (isTestnet ? 11_155_111 : 1);

/** Protocol scope 6, "trade:orderbook:option": place and cancel option orders, nothing else. */
export const DERIVE_SESSION_SCOPE = { code: 6n, wire: "trade:orderbook:option" } as const;
/** Session keys are re-registered when they lapse; 30 days keeps a lost key short-lived. */
export const DERIVE_SESSION_DAYS = 30;
const ORDER_SIGNATURE_TTL_SEC = 300;

/**
 * Fren's Derive session key is derived from the master key, so keystores made
 * before options existed get one without being rewritten.
 */
export function deriveSessionKeyOf(master: Hex): Hex {
  return keccak256(concat([master, toHex("fren/derive-session-key/v1")]));
}

export function deriveDomainSeparator(chainId: number): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "address" }],
      [DOMAIN_TYPEHASH, keccak256(toBytes("Matching")), keccak256(toBytes("1.0")), BigInt(chainId), DERIVE_MATCHING],
    ),
  );
}

export interface DeriveAction {
  subaccountId: bigint;
  nonce: bigint;
  module: Hex;
  data: Hex;
  expirySec: bigint;
  owner: Hex;
  signer: Hex;
}

export function deriveActionDigest(a: DeriveAction, chainId: number): Hex {
  const actionHash = keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "address" },
        { type: "bytes32" },
        { type: "uint256" },
        { type: "address" },
        { type: "address" },
      ],
      [ACTION_TYPEHASH, a.subaccountId, a.nonce, a.module, keccak256(a.data), a.expirySec, a.owner, a.signer],
    ),
  );
  return keccak256(concat(["0x1901", deriveDomainSeparator(chainId), actionHash]));
}

/** Same words as the SDK's encodeTradeData: every field is a static 32-byte slot. */
export function encodeDeriveTradeData(f: {
  assetAddress: Hex;
  subId: bigint;
  limitPriceE18: bigint;
  amountE18: bigint;
  maxFeeE18: bigint;
  recipientSubaccountId: bigint;
  isBid: boolean;
}): Hex {
  return encodeAbiParameters(
    [{ type: "address" }, { type: "uint256" }, { type: "int256" }, { type: "int256" }, { type: "uint256" }, { type: "uint256" }, { type: "bool" }],
    [getAddress(f.assetAddress), f.subId, f.limitPriceE18, f.amountE18, f.maxFeeE18, f.recipientSubaccountId, f.isBid],
  );
}

/** Decimal string to 1e18 units. Derive rejects anything finer than 1e-12. */
export function deriveE18(value: string, field: string): bigint {
  if (!/^\d+(\.\d+)?$/.test(value)) throw new SignerRuleError(`${field} must be a positive decimal string.`);
  const e18 = parseUnits(value, 18);
  if (e18 % 1_000_000n !== 0n) throw new SignerRuleError(`${field} has more than 12 decimal places.`);
  return e18;
}

/** A random nonce in Derive's format: milliseconds times 1e6 plus noise. */
function nonceNow(now: number): bigint {
  return BigInt(now) * 1_000_000n + BigInt(Math.floor(Math.random() * 1e6));
}

export interface DeriveOrderRequest {
  isTestnet: boolean;
  subaccountId: number;
  /** From public/get_instrument: base_asset_address and base_asset_sub_id. */
  assetAddress: Hex;
  subId: string;
  direction: "buy" | "sell";
  /** Decimal strings, as Derive's wire format. */
  amount: string;
  limitPrice: string;
  maxFee: string;
}

export interface DeriveOrderSignature {
  nonce: string;
  signer: Hex;
  signature: Hex;
  signatureExpirySec: number;
}

export async function signDeriveOrder(owner: Hex, session: PrivateKeyAccount, req: DeriveOrderRequest, now = Date.now()): Promise<DeriveOrderSignature> {
  if (!Number.isSafeInteger(req.subaccountId) || req.subaccountId <= 0) throw new SignerRuleError("Derive orders need a real subaccount id.");
  if (req.direction !== "buy" && req.direction !== "sell") throw new SignerRuleError("Direction must be buy or sell.");
  const amount = deriveE18(req.amount, "amount");
  const limitPrice = deriveE18(req.limitPrice, "limitPrice");
  const maxFee = deriveE18(req.maxFee, "maxFee");
  if (amount <= 0n || limitPrice <= 0n) throw new SignerRuleError("Amount and price must be positive.");
  const action: DeriveAction = {
    subaccountId: BigInt(req.subaccountId),
    nonce: nonceNow(now),
    module: DERIVE_TRADE_MODULE,
    // Proceeds always go back to the same subaccount.
    data: encodeDeriveTradeData({
      assetAddress: req.assetAddress,
      subId: BigInt(req.subId),
      limitPriceE18: limitPrice,
      amountE18: amount,
      maxFeeE18: maxFee,
      recipientSubaccountId: BigInt(req.subaccountId),
      isBid: req.direction === "buy",
    }),
    expirySec: BigInt(Math.floor(now / 1000) + ORDER_SIGNATURE_TTL_SEC),
    owner,
    signer: session.address,
  };
  const signature = await session.sign({ hash: deriveActionDigest(action, deriveChainId(req.isTestnet)) });
  return { nonce: action.nonce.toString(), signer: session.address, signature, signatureExpirySec: Number(action.expirySec) };
}

export type DeriveAuthHeaders = Record<"X-DeriveWallet" | "X-DeriveTimestamp" | "X-DeriveSignature", string>;

/** REST auth: the signer picks the timestamp, so it can only ever sign "now". */
export async function deriveAuthHeaders(owner: Hex, by: PrivateKeyAccount, now = Date.now()): Promise<DeriveAuthHeaders> {
  const timestamp = String(now);
  return { "X-DeriveWallet": owner, "X-DeriveTimestamp": timestamp, "X-DeriveSignature": await by.signMessage({ message: timestamp }) };
}

export interface DeriveSessionKeyRegistration {
  /** Auth headers signed by the owner, for this one request. */
  headers: DeriveAuthHeaders;
  /** Body for private/set_session_key. */
  params: Record<string, unknown>;
}

/** The one thing the owner key signs on Derive: Fren's own session key, option trading only, 30 days. */
export async function registerDeriveSessionKey(
  master: PrivateKeyAccount,
  session: PrivateKeyAccount,
  isTestnet: boolean,
  now = Date.now(),
): Promise<DeriveSessionKeyRegistration> {
  const expirySec = Math.floor(now / 1000) + DERIVE_SESSION_DAYS * 86_400;
  const action: DeriveAction = {
    subaccountId: 0n,
    nonce: nonceNow(now),
    module: DERIVE_SET_SESSION_KEY_MODULE,
    data: encodeAbiParameters(
      [{ type: "address" }, { type: "uint256" }, { type: "uint256[]" }, { type: "uint256[]" }],
      [session.address, BigInt(expirySec), [DERIVE_SESSION_SCOPE.code], []],
    ),
    expirySec: BigInt(Math.floor(now / 1000) + 600),
    owner: master.address,
    signer: master.address,
  };
  const signature = await master.sign({ hash: deriveActionDigest(action, deriveChainId(isTestnet)) });
  return {
    headers: await deriveAuthHeaders(master.address, master, now),
    params: {
      wallet: master.address,
      public_session_key: session.address,
      expiry_sec: expirySec,
      subaccount_ids: null,
      nonce: action.nonce.toString(),
      signer: master.address,
      signature,
      signature_expiry_sec: Number(action.expirySec),
      protocol_scopes: [DERIVE_SESSION_SCOPE.wire],
      offchain_scopes: ["account_info"],
      label: "fren",
    },
  };
}
