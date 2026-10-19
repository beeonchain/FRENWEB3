import { createWalletClient, encodeFunctionData, http, parseUnits, type PrivateKeyAccount } from "viem";
import { arbitrum, arbitrumSepolia } from "viem/chains";
import { SignerRuleError } from "./rules.js";

/**
 * Hyperliquid credits USDC sent to its bridge contract on Arbitrum to the
 * sender's own Hyperliquid account. This is the only EVM transaction the
 * signer will ever send, and its destination is fixed in code.
 */
export const HL_BRIDGE = {
  mainnet: {
    chain: arbitrum,
    bridge: "0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7",
    usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    rpc: "https://arb1.arbitrum.io/rpc",
  },
  testnet: {
    chain: arbitrumSepolia,
    bridge: "0x08cfc1B6b2dCF36A1480b99353A354AA8AC56f89",
    usdc: "0x1baAbB04529D43a73232B713C0FE471f7c7334d5",
    rpc: "https://sepolia-rollup.arbitrum.io/rpc",
  },
} as const;

/** Deposits under 5 USDC are lost by the bridge. */
export const HL_MIN_DEPOSIT_USD = 5;

const ERC20_TRANSFER = [
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;

export async function depositToHyperliquid(
  account: PrivateKeyAccount,
  amountUsd: number,
  isTestnet: boolean,
  rpcUrl?: string,
): Promise<`0x${string}`> {
  if (!(amountUsd >= HL_MIN_DEPOSIT_USD)) {
    throw new SignerRuleError(`Hyperliquid deposits must be at least ${HL_MIN_DEPOSIT_USD} USDC; smaller ones are lost.`);
  }
  const net = isTestnet ? HL_BRIDGE.testnet : HL_BRIDGE.mainnet;
  const client = createWalletClient({ account, chain: net.chain, transport: http(rpcUrl ?? net.rpc) });
  return client.sendTransaction({
    to: net.usdc,
    data: encodeFunctionData({ abi: ERC20_TRANSFER, functionName: "transfer", args: [net.bridge, parseUnits(amountUsd.toFixed(6), 6)] }),
  });
}
