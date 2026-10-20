import { decodeFunctionData, getAddress, parseAbi, toFunctionSelector, type Hex, type PrivateKeyAccount, type TypedDataDefinition } from "viem";
import { SignerRuleError } from "./rules.js";

/**
 * Polymarket signing. Polymarket's SDK asks a wallet for EIP-712 signatures
 * only: API-key login, orders, and gasless "Batch" calls from the user's
 * Polymarket deposit wallet (approvals). The signer checks each one against
 * Polymarket's own contracts and refuses everything else, including any batch
 * call that could move collateral or shares out of the wallet.
 *
 * Addresses are Polymarket's production config from @polymarket/client 0.13.0.
 */

export const POLYGON_CHAIN_ID = 137;

const lower = (xs: string[]) => new Set(xs.map((x) => x.toLowerCase()));

/** Order books whose orders the signer will sign. */
export const POLY_EXCHANGES = lower([
  "0xE111180000d2663C0091e4f400237545B87B996B", // standard exchange
  "0xe2222d279d744050d28e00520010520000310F59", // neg-risk exchange
  "0xe3333700cA9d93003F00f0F71f8515005F6c00Aa", // exchange v3
]);

/** Polymarket contracts a deposit wallet may approve to pull its collateral or shares. */
export const POLY_SPENDERS = lower([
  ...POLY_EXCHANGES,
  "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045", // conditional tokens
  "0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296", // neg-risk adapter
  "0xAdA100Db00Ca00073811820692005400218FcE1f", // collateral adapter
  "0xadA2005600Dec949baf300f4C6120000bDB6eAab", // neg-risk collateral adapter
  "0x12121212006e4CD160D18e3f00711DA5c3372600", // protocol v2 router
  "0x006F54F7f9A22e0000CC2AB60031000000ae9fEF", // position manager
  "0x1000008dD9001B968442c1000017eaE6E0dA00Ba", // binary module
  "0x200000900045e3B6259600682756002200028933", // neg-risk module
  "0x30000034706c7d8e12009dab006be20000c031a8", // combinatorial module
  "0xa1200000d0002264C9a1698e001292D00E1b00af", // auto-redeem operator: pays winnings back into the wallet
]);

/** Contracts whose redeem calls pay the caller (the wallet itself). */
const POLY_REDEEMERS = lower([
  "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045",
  "0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296",
  "0x006F54F7f9A22e0000CC2AB60031000000ae9fEF",
]);

const BATCH_ABI = parseAbi([
  "function approve(address spender, uint256 amount)",
  "function setApprovalForAll(address operator, bool approved)",
  "function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)",
  "function redeem(bytes31 conditionId, uint256 outcomeIndex, uint256 amount)",
]);
const SELECTORS = {
  approve: toFunctionSelector(BATCH_ABI[0]),
  setApprovalForAll: toFunctionSelector(BATCH_ABI[1]),
  redeemPositions: toFunctionSelector(BATCH_ABI[2]),
  redeem: toFunctionSelector(BATCH_ABI[3]),
};

export interface PolyTypedData {
  domain: { name?: string; version?: string; chainId?: number | bigint | string; verifyingContract?: string; salt?: string };
  types: Record<string, { name: string; type: string }[]>;
  primaryType: string;
  message: Record<string, unknown>;
}

const EXCHANGE_DOMAIN = "Polymarket CTF Exchange";

function checkExchangeDomain(d: PolyTypedData["domain"]) {
  if (d.name !== EXCHANGE_DOMAIN) throw new SignerRuleError(`Orders must be for "${EXCHANGE_DOMAIN}", not "${String(d.name)}".`);
  if (!d.verifyingContract || !POLY_EXCHANGES.has(d.verifyingContract.toLowerCase())) {
    throw new SignerRuleError(`Exchange ${String(d.verifyingContract)} is not one of Polymarket's.`);
  }
}

function checkBatchCall(call: Record<string, unknown>, i: number) {
  const target = String(call.target ?? "").toLowerCase();
  const data = String(call.data ?? "0x") as Hex;
  if (BigInt(String(call.value ?? 0)) !== 0n) throw new SignerRuleError(`Batch call ${i + 1} sends POL; Fren never does.`);
  const selector = data.slice(0, 10).toLowerCase();
  if (selector === SELECTORS.approve || selector === SELECTORS.setApprovalForAll) {
    const { args } = decodeFunctionData({ abi: BATCH_ABI, data });
    const spender = String(args?.[0] ?? "").toLowerCase();
    if (!POLY_SPENDERS.has(spender)) throw new SignerRuleError(`Batch call ${i + 1} approves ${spender}, which is not a Polymarket contract.`);
    return;
  }
  if ((selector === SELECTORS.redeemPositions || selector === SELECTORS.redeem) && POLY_REDEEMERS.has(target)) return;
  throw new SignerRuleError(`Batch call ${i + 1} (${selector} on ${target}) is not an approval or a redeem; the signer refuses it.`);
}

/** Throws unless this is something Fren's Polymarket wallet should sign. */
export function checkPolymarketTypedData(p: PolyTypedData, owner: Hex): void {
  if (Number(p.domain?.chainId) !== POLYGON_CHAIN_ID) throw new SignerRuleError("Polymarket signatures are for Polygon only.");
  switch (p.primaryType) {
    case "ClobAuth": {
      if (p.domain.name !== "ClobAuthDomain") throw new SignerRuleError("Unexpected login domain.");
      if (String(p.message.address).toLowerCase() !== owner.toLowerCase()) throw new SignerRuleError("Login is for another address.");
      return;
    }
    case "Order":
      checkExchangeDomain(p.domain);
      return;
    case "TypedDataSign": {
      // An order signed for the deposit wallet (ERC-1271): the outer domain is the exchange.
      checkExchangeDomain(p.domain);
      if (p.message.name !== "DepositWallet" || typeof p.message.contents !== "object") throw new SignerRuleError("Unexpected wallet order wrapper.");
      return;
    }
    case "Batch": {
      if (p.domain.name !== "DepositWallet") throw new SignerRuleError("Batches must come from a Polymarket deposit wallet.");
      if (String(p.message.wallet).toLowerCase() !== String(p.domain.verifyingContract).toLowerCase()) throw new SignerRuleError("Batch wallet mismatch.");
      const calls = p.message.calls;
      if (!Array.isArray(calls) || calls.length === 0) throw new SignerRuleError("Empty batch.");
      calls.forEach((c, i) => checkBatchCall(c as Record<string, unknown>, i));
      return;
    }
    default:
      throw new SignerRuleError(`Polymarket "${p.primaryType}" signatures are not allowed (withdrawals and transfers stay with you).`);
  }
}

export async function signPolymarketTypedData(account: PrivateKeyAccount, p: PolyTypedData): Promise<Hex> {
  checkPolymarketTypedData(p, account.address);
  const { EIP712Domain: _domainTypes, ...types } = p.types;
  const domain = { ...p.domain, chainId: Number(p.domain.chainId), ...(p.domain.verifyingContract ? { verifyingContract: getAddress(p.domain.verifyingContract) } : {}) };
  return account.signTypedData({ domain, types, primaryType: p.primaryType, message: p.message } as unknown as TypedDataDefinition);
}
