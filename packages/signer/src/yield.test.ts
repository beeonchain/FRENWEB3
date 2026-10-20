import { encodeFunctionData, erc20Abi, maxUint256, parseAbi } from "viem";
import { describe, expect, it } from "vitest";
import { checkEvmTransaction } from "./evm.js";

const POOL_ARB = "0x794a61358D6845594F94dc1DB02A252b5b4814aD";
const USDC_ARB = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const OWNER = "0x1111111111111111111111111111111111111111";
const STRANGER = "0x9999999999999999999999999999999999999999";
const pool = parseAbi([
  "function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)",
  "function withdraw(address asset, uint256 amount, address to) returns (uint256)",
  "function borrow(address asset, uint256 amount, uint256 interestRateMode, uint16 referralCode, address onBehalfOf)",
]);

const tx = (data: `0x${string}`, to: string = POOL_ARB) => ({ chainId: 42161, to: to as `0x${string}`, data });

describe("Aave rules", () => {
  it("lets the wallet approve the pool for USDC, supply for itself and withdraw to itself", () => {
    expect(checkEvmTransaction(tx(encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [POOL_ARB, 100_000_000n] }), USDC_ARB), OWNER).kind).toBe("approve");
    expect(checkEvmTransaction(tx(encodeFunctionData({ abi: pool, functionName: "supply", args: [USDC_ARB, 100_000_000n, OWNER, 0] })), OWNER).kind).toBe("aave");
    expect(checkEvmTransaction(tx(encodeFunctionData({ abi: pool, functionName: "withdraw", args: [USDC_ARB, maxUint256, OWNER] })), OWNER).kind).toBe("aave");
  });

  it("refuses supplying for someone else, withdrawing to someone else, borrowing, and other assets", () => {
    expect(() => checkEvmTransaction(tx(encodeFunctionData({ abi: pool, functionName: "supply", args: [USDC_ARB, 1n, STRANGER, 0] })), OWNER)).toThrow(/credit the wallet itself/);
    expect(() => checkEvmTransaction(tx(encodeFunctionData({ abi: pool, functionName: "withdraw", args: [USDC_ARB, 1n, STRANGER] })), OWNER)).toThrow(/pay the wallet itself/);
    expect(() => checkEvmTransaction(tx(encodeFunctionData({ abi: pool, functionName: "borrow", args: [USDC_ARB, 1n, 2n, 0, OWNER] })), OWNER)).toThrow();
    expect(() => checkEvmTransaction(tx(encodeFunctionData({ abi: pool, functionName: "supply", args: [USDC_BASE, 1n, OWNER, 0] })), OWNER)).toThrow(/only lends USDC/);
    expect(() => checkEvmTransaction(tx(encodeFunctionData({ abi: pool, functionName: "supply", args: [USDC_ARB, 1n, OWNER, 0] })))).toThrow(/sending wallet/);
  });

  it("only approves the pool on its own chain, for USDC, for a bounded amount", () => {
    const approve = (spender: string, amount: bigint) => encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender as `0x${string}`, amount] });
    expect(() => checkEvmTransaction({ chainId: 8453, to: USDC_BASE, data: approve(POOL_ARB, 1n) }, OWNER)).toThrow(/not on the signer's allow list/);
    expect(() => checkEvmTransaction(tx(approve(POOL_ARB, 1n), STRANGER), OWNER)).toThrow(/USDC only/);
    expect(() => checkEvmTransaction(tx(approve(POOL_ARB, maxUint256), USDC_ARB), OWNER)).toThrow(/Unlimited/);
  });
});
