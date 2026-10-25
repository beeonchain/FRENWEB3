import { NETWORKS, SignedAction, domainSeparator } from "@derivexyz/derive-ts";
import { encodeSetSessionKeyActionData, encodeTradeData } from "@derivexyz/derive-ts/codecs";
import { Wallet } from "ethers";
import { encodeFunctionData, parseAbi, recoverAddress, recoverMessageAddress, verifyTypedData, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import {
  DERIVE_TRADE_MODULE,
  deriveActionDigest,
  deriveDomainSeparator,
  deriveSessionKeyOf,
  encodeDeriveTradeData,
  registerDeriveSessionKey,
  signDeriveOrder,
} from "./derive.js";
import { generateKeys } from "./keystore.js";
import { checkPolymarketTypedData, type PolyTypedData } from "./polymarket.js";
import { createSigner } from "./signer.js";
import { decodeLine, encodeLine } from "./protocol.js";

const ETH_OPTION_ASSET = "0x4BB4C3CDc7562f08e9910A0C7D8bB7e108861eB4" as Hex;

describe("Derive signing matches Derive's own SDK", () => {
  it("computes the same domain separator", () => {
    expect(deriveDomainSeparator(1)).toBe(domainSeparator(NETWORKS.mainnet));
    expect(deriveDomainSeparator(11_155_111)).toBe(domainSeparator(NETWORKS.testnet));
  });

  it("encodes trade data and session-key data byte for byte", () => {
    const sdk = encodeTradeData({
      assetAddress: ETH_OPTION_ASSET,
      subId: "39614081257132168796771975168",
      limitPrice: "152.5",
      amount: "2.5",
      maxFee: "10",
      recipientSubaccountId: 1234,
      isBid: true,
    });
    const ours = encodeDeriveTradeData({
      assetAddress: ETH_OPTION_ASSET,
      subId: 39614081257132168796771975168n,
      limitPriceE18: 152_500_000_000_000_000_000n,
      amountE18: 2_500_000_000_000_000_000n,
      maxFeeE18: 10n * 10n ** 18n,
      recipientSubaccountId: 1234n,
      isBid: true,
    });
    expect(ours.toLowerCase()).toBe(sdk.toLowerCase());
  });

  it("produces a signature the SDK's own action would produce", async () => {
    const owner = privateKeyToAccount(generateKeys().evmMaster);
    const sessionKey = deriveSessionKeyOf(generateKeys().evmMaster);
    const session = privateKeyToAccount(sessionKey);
    const now = 1_790_000_000_000;
    const ours = await signDeriveOrder(
      owner.address,
      session,
      { isTestnet: false, subaccountId: 1234, assetAddress: ETH_OPTION_ASSET, subId: "7", direction: "buy", amount: "1", limitPrice: "100", maxFee: "5" },
      now,
    );
    const sdkAction = new SignedAction(
      {
        subaccountId: 1234,
        nonce: ours.nonce,
        module: DERIVE_TRADE_MODULE,
        data: encodeTradeData({ assetAddress: ETH_OPTION_ASSET, subId: "7", limitPrice: "100", amount: "1", maxFee: "5", recipientSubaccountId: 1234, isBid: true }),
        expirySec: ours.signatureExpirySec,
        owner: owner.address,
        signer: session.address,
      },
      domainSeparator(NETWORKS.mainnet),
    ).sign(new Wallet(sessionKey));
    expect(ours.signature.toLowerCase()).toBe(sdkAction.signature!.toLowerCase());
  });

  it("registers only Fren's own session key, for option trading, signed by the owner", async () => {
    const master = privateKeyToAccount(generateKeys().evmMaster);
    const session = privateKeyToAccount(generateKeys().hlAgent);
    const reg = await registerDeriveSessionKey(master, session, false, 1_790_000_000_000);
    expect(reg.params).toMatchObject({ wallet: master.address, public_session_key: session.address, protocol_scopes: ["trade:orderbook:option"], signer: master.address });
    const data = encodeSetSessionKeyActionData({ sessionKey: session.address, expirySec: reg.params.expiry_sec as number, scopes: [6], subaccountIds: [] });
    const digest = deriveActionDigest(
      {
        subaccountId: 0n,
        nonce: BigInt(reg.params.nonce as string),
        module: "0xe330CF64ff6EbF41699aad344Cb21d78db1D2bb6",
        data: data as Hex,
        expirySec: BigInt(reg.params.signature_expiry_sec as number),
        owner: master.address,
        signer: master.address,
      },
      1,
    );
    expect(await recoverAddress({ hash: digest, signature: reg.params.signature as Hex })).toBe(master.address);
    expect(await recoverMessageAddress({ message: reg.headers["X-DeriveTimestamp"], signature: reg.headers["X-DeriveSignature"] as Hex })).toBe(master.address);
  });

  it("refuses orders without a subaccount or with sub-1e-12 amounts", async () => {
    const s = createSigner(generateKeys());
    const base = { isTestnet: false, subaccountId: 1, assetAddress: ETH_OPTION_ASSET, subId: "1", direction: "buy" as const, amount: "1", limitPrice: "1", maxFee: "1" };
    await expect(s.deriveSignOrder({ ...base, subaccountId: 0 })).rejects.toThrow(/subaccount/);
    await expect(s.deriveSignOrder({ ...base, amount: "0.0000000000001" })).rejects.toThrow(/12 decimal places/);
    await expect(s.deriveSignOrder({ ...base, limitPrice: "-1" })).rejects.toThrow(/positive decimal/);
    const addrs = await s.addresses();
    const headers = await s.deriveAuthHeaders({ isTestnet: false });
    expect(headers["X-DeriveWallet"]).toBe(addrs.evm);
    expect(await recoverMessageAddress({ message: headers["X-DeriveTimestamp"], signature: headers["X-DeriveSignature"] as Hex })).toBe(addrs.deriveSession);
  });
});

const EXCHANGE_V3 = "0xe3333700cA9d93003F00f0F71f8515005F6c00Aa";
const PUSD = "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB";
const CTF = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";
const WALLET = "0x5555555555555555555555555555555555555555";
const STRANGER = "0x9999999999999999999999999999999999999999";
const erc = parseAbi([
  "function approve(address spender, uint256 amount)",
  "function transfer(address recipient, uint256 amount)",
  "function setApprovalForAll(address operator, bool approved)",
]);

const batch = (calls: { target: string; data: Hex; value?: bigint }[]): PolyTypedData => ({
  domain: { name: "DepositWallet", version: "1", chainId: 137, verifyingContract: WALLET },
  types: {
    Batch: [
      { name: "wallet", type: "address" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
      { name: "calls", type: "Call[]" },
    ],
    Call: [
      { name: "target", type: "address" },
      { name: "value", type: "uint256" },
      { name: "data", type: "bytes" },
    ],
  },
  primaryType: "Batch",
  message: { wallet: WALLET, nonce: 1n, deadline: 2_000_000_000n, calls: calls.map((c) => ({ value: 0n, ...c })) },
});

const order = (verifyingContract: string): PolyTypedData => ({
  domain: { name: "Polymarket CTF Exchange", version: "3", chainId: 137, verifyingContract },
  types: {
    Order: [
      { name: "salt", type: "uint256" },
      { name: "maker", type: "address" },
      { name: "signer", type: "address" },
      { name: "tokenId", type: "uint256" },
      { name: "makerAmount", type: "uint256" },
      { name: "takerAmount", type: "uint256" },
      { name: "side", type: "uint8" },
      { name: "signatureType", type: "uint8" },
      { name: "timestamp", type: "uint256" },
      { name: "metadata", type: "bytes32" },
      { name: "builder", type: "bytes32" },
    ],
  },
  primaryType: "Order",
  message: {
    salt: 1n,
    maker: WALLET,
    signer: WALLET,
    tokenId: 42n,
    makerAmount: 10_000_000n,
    takerAmount: 20_000_000n,
    side: 0,
    signatureType: 0,
    timestamp: 1n,
    metadata: `0x${"0".repeat(64)}`,
    builder: `0x${"0".repeat(64)}`,
  },
});

describe("Polymarket signing rules", () => {
  const owner = "0x1111111111111111111111111111111111111111" as Hex;

  it("signs orders for Polymarket's exchanges only", () => {
    expect(() => checkPolymarketTypedData(order(EXCHANGE_V3), owner)).not.toThrow();
    expect(() => checkPolymarketTypedData(order(STRANGER), owner)).toThrow(/not one of Polymarket's/);
    expect(() => checkPolymarketTypedData({ ...order(EXCHANGE_V3), domain: { ...order(EXCHANGE_V3).domain, chainId: 1 } }, owner)).toThrow(/Polygon only/);
  });

  it("lets the deposit wallet approve Polymarket contracts and nothing else", () => {
    const approve = (spender: string) => encodeFunctionData({ abi: erc, functionName: "approve", args: [spender as Hex, 2n ** 256n - 1n] });
    expect(() => checkPolymarketTypedData(batch([{ target: PUSD, data: approve(EXCHANGE_V3) }]), owner)).not.toThrow();
    expect(() =>
      checkPolymarketTypedData(batch([{ target: CTF, data: encodeFunctionData({ abi: erc, functionName: "setApprovalForAll", args: [EXCHANGE_V3, true] }) }]), owner),
    ).not.toThrow();
    expect(() => checkPolymarketTypedData(batch([{ target: PUSD, data: approve(STRANGER) }]), owner)).toThrow(/not a Polymarket contract/);
    expect(() =>
      checkPolymarketTypedData(batch([{ target: PUSD, data: encodeFunctionData({ abi: erc, functionName: "transfer", args: [STRANGER, 1n] }) }]), owner),
    ).toThrow(/not an approval or a redeem/);
    expect(() => checkPolymarketTypedData(batch([{ target: PUSD, data: approve(EXCHANGE_V3), value: 1n }]), owner)).toThrow(/sends POL/);
  });

  it("refuses withdrawals and logins for other addresses", () => {
    const withdraw: PolyTypedData = { domain: { name: "Polymarket", version: "1", chainId: 137, verifyingContract: STRANGER }, types: {}, primaryType: "Withdraw", message: {} };
    expect(() => checkPolymarketTypedData(withdraw, owner)).toThrow(/not allowed/);
    const login = (address: string): PolyTypedData => ({ domain: { name: "ClobAuthDomain", version: "1", chainId: 137 }, types: {}, primaryType: "ClobAuth", message: { address } });
    expect(() => checkPolymarketTypedData(login(owner), owner)).not.toThrow();
    expect(() => checkPolymarketTypedData(login(STRANGER), owner)).toThrow(/another address/);
  });

  it("signs a valid order that verifies, and bigints survive the process boundary", async () => {
    const keys = generateKeys();
    const s = createSigner(keys);
    const { evm } = await s.addresses();
    const payload = decodeLine(encodeLine(order(EXCHANGE_V3))) as PolyTypedData;
    expect(payload.message.makerAmount).toBe(10_000_000n);
    const sig = await s.polySignTypedData(payload);
    const { EIP712Domain: _d, ...types } = payload.types;
    expect(await verifyTypedData({ address: evm, domain: { ...payload.domain, chainId: 137, verifyingContract: EXCHANGE_V3 }, types, primaryType: "Order", message: payload.message, signature: sig } as never)).toBe(true);
  });
});
