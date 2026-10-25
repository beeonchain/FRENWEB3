import { createWalletClient, decodeFunctionData, http, type Chain, type PrivateKeyAccount } from "viem";
import { arbitrum, arbitrumSepolia, base, baseSepolia, robinhood, robinhoodTestnet } from "viem/chains";
import { SignerRuleError } from "./rules.js";

/**
 * EVM transactions the master key may send besides the Hyperliquid deposit.
 * Every one goes to a contract on a fixed list, carries no ETH, and an ERC-20
 * approval may only name a listed spender for a bounded amount. Like Jupiter
 * on Solana, the listed contracts' own calldata is trusted; the list is what
 * keeps an arbitrary "send everything to X" transaction from being signed.
 */

export const EVM_CHAINS: Record<number, { chain: Chain; rpc: string }> = {
  42161: { chain: arbitrum, rpc: "https://arb1.arbitrum.io/rpc" },
  8453: { chain: base, rpc: "https://mainnet.base.org" },
  4663: { chain: robinhood, rpc: "https://rpc.mainnet.chain.robinhood.com" },
  421614: { chain: arbitrumSepolia, rpc: "https://sepolia-rollup.arbitrum.io/rpc" },
  84532: { chain: baseSepolia, rpc: "https://sepolia.base.org" },
  46630: { chain: robinhoodTestnet, rpc: "https://rpc.testnet.chain.robinhood.com" },
};

/**
 * Relay's routers and approval proxies (v3 and v3.2, London and Cancun chain
 * groups; Relay moves to v3.2 on 2026-10-26 and says to allow both), plus the
 * Base depository from Relay's docs. Lower-case.
 */
export const RELAY_CONTRACTS = new Set([
  "0x9ef6d3c2f60d7b9008d74cab1fc0f899c957c819", // v3 router (London)
  "0x8754bc615047de01228a7527b712806a71a8dc9a", // v3 approval proxy (London)
  "0xb92fe925dc43a0ecde6c8b1a2709c170ec4fff4f", // v3 router (Cancun)
  "0xccc88a9d1b4ed6b0eaba998850414b24f1c315be", // v3 approval proxy (Cancun)
  "0x6328ea02d28131e58b28e55c6258258a30d90e05", // v3.2 router (London)
  "0xe4dfbd5e6784db1058124e2c87554c0591f0fb7b", // v3.2 approval proxy (London)
  "0x0729e2a4716d9f7dd17858d5d504426d228697f7", // v3.2 router (Cancun)
  "0x5567954cd026cebfe486062cb75848e0f1c12e58", // v3.2 approval proxy (Cancun)
  "0x4cd00e387622c35bddb9b4c962c136462338bc31", // depository (Base)
]);

const ERC20_APPROVE = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;

const APPROVE_SELECTOR = "0x095ea7b3";

/** Approvals must be for a real amount, never "unlimited". 10^30 raw is far above any balance Fren handles. */
export const MAX_APPROVAL_RAW = 10n ** 30n;

export interface EvmTxRequest {
  chainId: number;
  to: `0x${string}`;
  data: `0x${string}`;
  /** Wei. The signer refuses anything but zero. */
  value?: string;
  gas?: string;
}

export type EvmTxKind = "relay" | "approve";

export function checkEvmTransaction(req: EvmTxRequest): { kind: EvmTxKind; spender?: string } {
  if (!EVM_CHAINS[req.chainId]) throw new SignerRuleError(`Chain ${req.chainId} is not one the signer sends on.`);
  if (req.value !== undefined && BigInt(req.value) !== 0n) {
    throw new SignerRuleError("EVM transactions from Fren never send ETH.");
  }
  const to = req.to.toLowerCase();
  if (req.data.slice(0, 10).toLowerCase() === APPROVE_SELECTOR) {
    const { args } = decodeFunctionData({ abi: ERC20_APPROVE, data: req.data });
    const [spender, amount] = args;
    if (!RELAY_CONTRACTS.has(spender.toLowerCase())) throw new SignerRuleError(`Approval for ${spender}, which is not on the signer's allow list.`);
    if (amount > MAX_APPROVAL_RAW) throw new SignerRuleError("Unlimited token approvals are not allowed.");
    return { kind: "approve", spender };
  }
  if (!RELAY_CONTRACTS.has(to)) throw new SignerRuleError(`Contract ${req.to} is not on the signer's allow list.`);
  return { kind: "relay" };
}

export async function sendEvmTransaction(
  account: PrivateKeyAccount,
  req: EvmTxRequest,
  rpcOverrides: Record<number, string> = {},
): Promise<`0x${string}`> {
  checkEvmTransaction(req);
  const net = EVM_CHAINS[req.chainId]!;
  const client = createWalletClient({ account, chain: net.chain, transport: http(rpcOverrides[req.chainId] ?? net.rpc) });
  return client.sendTransaction({
    to: req.to,
    data: req.data,
    value: 0n,
    ...(req.gas ? { gas: BigInt(req.gas) } : {}),
  });
}
