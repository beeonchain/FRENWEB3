import { Connection, Keypair, VersionedTransaction } from "@solana/web3.js";
import { privateKeyToAccount } from "viem/accounts";
import { signL1Action, signUserSignedAction, type Signature } from "@nktkas/hyperliquid/signing";
import { ApproveAgentTypes } from "@nktkas/hyperliquid/api/exchange";
import { depositToHyperliquid } from "./arbitrum.js";
import { sendEvmTransaction, type EvmTxRequest } from "./evm.js";
import {
  deriveAuthHeaders,
  deriveSessionKeyOf,
  registerDeriveSessionKey,
  signDeriveOrder,
  type DeriveAuthHeaders,
  type DeriveOrderRequest,
  type DeriveOrderSignature,
  type DeriveSessionKeyRegistration,
} from "./derive.js";
import { signPolymarketTypedData, type PolyTypedData } from "./polymarket.js";
import { addressesOf, type Addresses, type KeyMaterial } from "./keystore.js";
import { SignerRuleError, checkHyperliquidAction, checkSolanaTransaction, type SolanaTxReport } from "./rules.js";

export type { Signature };

export interface HlSignRequest {
  action: Record<string, unknown>;
  nonce: number;
  isTestnet: boolean;
  expiresAfter?: number;
}

export interface HlApproveAgentResult {
  action: Record<string, unknown>;
  signature: Signature;
  nonce: number;
}

export interface SolSignRequest {
  txBase64: string;
  /** Upper bound on SOL (in lamports) the wallet may lose in this transaction, fees included. */
  maxSolSpendLamports: number;
  /** Launch snipes only: allow a Jito tip up to this many lamports (the signer caps it at 0.01 SOL). */
  jitoTipLamports?: number;
}

export interface SolSignResult {
  signedTxBase64: string;
  report: SolanaTxReport & { simulatedSolDeltaLamports?: number };
}

/** The whole surface the engine can reach. Nothing here can export a key or move funds to an outside address. */
export interface SignerApi {
  addresses(): Promise<Addresses>;
  hlSignL1(req: HlSignRequest): Promise<Signature>;
  hlApproveAgent(req: { isTestnet: boolean }): Promise<HlApproveAgentResult>;
  solSignTransaction(req: SolSignRequest): Promise<SolSignResult>;
  /** Move USDC from the wallet's own Arbitrum address into its own Hyperliquid account. */
  hlDepositFromArbitrum(req: { amountUsd: number; isTestnet: boolean }): Promise<{ txHash: `0x${string}` }>;
  /** Send an EVM transaction to an allow-listed contract (Relay swaps and their approvals). Never carries ETH. */
  evmSendTransaction(req: EvmTxRequest): Promise<{ txHash: `0x${string}` }>;
  /** Sign a Derive option order with the session key. The signer builds the action; it can only be a trade. */
  deriveSignOrder(req: DeriveOrderRequest): Promise<DeriveOrderSignature>;
  /** Derive REST auth headers from the session key, for the current time. */
  deriveAuthHeaders(req: { isTestnet: boolean }): Promise<DeriveAuthHeaders>;
  /** The master key registers Fren's own session key with the option-trading scope only. */
  deriveRegisterSessionKey(req: { isTestnet: boolean }): Promise<DeriveSessionKeyRegistration>;
  /** Polymarket EIP-712: login, orders, and deposit-wallet approvals. Nothing that moves funds out. */
  polySignTypedData(req: PolyTypedData): Promise<`0x${string}`>;
}

export interface SignerOptions {
  /** Solana RPC used only for pre-sign simulation. Omit to skip simulation (tests, paper). */
  solanaRpcUrl?: string;
  /** Arbitrum RPC for Hyperliquid deposits. Defaults to the public endpoint. */
  arbitrumRpcUrl?: string;
  /** RPC per EVM chain id, overriding the public defaults. */
  evmRpcUrls?: Record<number, string>;
}

export const HL_AGENT_NAME = "fren";

export function createSigner(keys: KeyMaterial, options: SignerOptions = {}): SignerApi {
  const addresses = addressesOf(keys);
  const sol = Keypair.fromSecretKey(Buffer.from(keys.solanaSecret, "base64"));
  const master = privateKeyToAccount(keys.evmMaster);
  const agent = privateKeyToAccount(keys.hlAgent);
  const deriveSession = privateKeyToAccount(deriveSessionKeyOf(keys.evmMaster));
  const connection = options.solanaRpcUrl ? new Connection(options.solanaRpcUrl, "confirmed") : undefined;

  return {
    async addresses() {
      return addresses;
    },

    async hlSignL1(req) {
      checkHyperliquidAction(req.action);
      return signL1Action({
        wallet: agent,
        action: req.action,
        nonce: req.nonce,
        isTestnet: req.isTestnet,
        ...(req.expiresAfter !== undefined ? { expiresAfter: req.expiresAfter } : {}),
      });
    },

    async hlApproveAgent({ isTestnet }) {
      // The master key signs exactly one kind of thing: approving our own agent key.
      const nonce = Date.now();
      const action = {
        type: "approveAgent",
        signatureChainId: (isTestnet ? "0x66eee" : "0xa4b1") as `0x${string}`,
        hyperliquidChain: isTestnet ? "Testnet" : "Mainnet",
        agentAddress: agent.address.toLowerCase(),
        agentName: HL_AGENT_NAME,
        nonce,
      };
      const signature = await signUserSignedAction({ wallet: master, action, types: ApproveAgentTypes });
      return { action, signature, nonce };
    },

    async solSignTransaction(req) {
      const tx = VersionedTransaction.deserialize(Buffer.from(req.txBase64, "base64"));
      const report: SolSignResult["report"] = checkSolanaTransaction(tx, sol.publicKey, {
        ...(req.jitoTipLamports !== undefined ? { jitoTipLamports: req.jitoTipLamports } : {}),
      });

      if (connection) {
        const before = await connection.getBalance(sol.publicKey, "confirmed");
        const sim = await connection.simulateTransaction(tx, {
          sigVerify: false,
          replaceRecentBlockhash: true,
          accounts: { encoding: "base64", addresses: [sol.publicKey.toBase58()] },
        });
        if (sim.value.err) {
          throw new SignerRuleError(`Simulation failed: ${JSON.stringify(sim.value.err)}`);
        }
        const after = sim.value.accounts?.[0]?.lamports;
        if (after === undefined) throw new SignerRuleError("Simulation did not return the wallet balance.");
        const delta = after - before;
        report.simulatedSolDeltaLamports = delta;
        if (-delta > req.maxSolSpendLamports) {
          throw new SignerRuleError(
            `Simulation shows the wallet losing ${-delta} lamports, more than the ${req.maxSolSpendLamports} allowed.`,
          );
        }
      }

      tx.sign([sol]);
      return { signedTxBase64: Buffer.from(tx.serialize()).toString("base64"), report };
    },

    async hlDepositFromArbitrum({ amountUsd, isTestnet }) {
      return { txHash: await depositToHyperliquid(master, amountUsd, isTestnet, options.arbitrumRpcUrl) };
    },

    async evmSendTransaction(req) {
      return { txHash: await sendEvmTransaction(master, req, options.evmRpcUrls) };
    },

    async deriveSignOrder(req) {
      return signDeriveOrder(master.address, deriveSession, req);
    },

    async deriveAuthHeaders() {
      return deriveAuthHeaders(master.address, deriveSession);
    },

    async deriveRegisterSessionKey({ isTestnet }) {
      return registerDeriveSessionKey(master, deriveSession, isTestnet);
    },

    async polySignTypedData(req) {
      return signPolymarketTypedData(master, req);
    },
  };
}
