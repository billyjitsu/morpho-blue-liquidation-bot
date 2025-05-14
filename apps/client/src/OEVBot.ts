import { executorAbi, ExecutorEncoder } from "executooor-viem";
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  getAddress,
  http,
  getContract,
  keccak256,
  toHex,
  encodePacked,
  encodeAbiParameters,
  parseAbiParameters,
  maxUint256,
  parseEther,
  decodeEventLog,
  parseGwei,
  TransactionReceipt,
  parseAbiItem,
  concat,
  type Account,
  type Address,
  type Chain,
  type Client,
  type Hex,
  type Transport,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { estimateGas, readContract, writeContract } from "viem/actions";

import OevAuctionHouseAbi from "./contractAbis/OevAuctionHouse.json";
import OevFeedUpdaterAbi from "./contractAbis/OevFeedUpdater.json";
import type { LiquidityVenue } from "./liquidityVenues/liquidityVenue.js";
import { fetchOEVSignedData } from "./utils/fetch-oevsigneddata";
import { fetchLiquidatablePositions, fetchWhiteListedMarketsForVault } from "./utils/fetchers.js";

// Constants
const OEV_AUCTION_LENGTH_SECONDS = 30;
const OEV_BIDDING_PHASE_LENGTH_SECONDS = 25;
const OEV_BIDDING_PHASE_BUFFER_SECONDS = 3;
const OEV_AUCTIONS_MAJOR_VERSION = 1;
const DAPP_ID = 1; // The dAppId of the communal proxies

// Environment variables
const BID_AMOUNT = process.env.BID_AMOUNT || "0.0001"; // Default: 0.001 MNT
const DAPI_NAME = process.env.DAPI_NAME || "ETH/USD"; // Default: ETH/USD

// Contract ABIs
const OevAuctionHouseABI = OevAuctionHouseAbi; // Import the ABI from the JSON file
const OevFeedUpdaterABI = OevFeedUpdaterAbi.abi; // Import the ABI from the JSON file

interface OevChain extends Chain {
  rpcUrls: {
    default: {
      http: string[];
    };
    public: {
      http: string[];
    };
  };
}
interface PayBidAndUpdateFeeds {
  signedDataTimestampCutoff: number;
  signature: Hex;
  bidAmount: bigint;
  payOevBidCallbackData: {
    signedDataArray: Hex[];
  };
}

interface AwardedBidEventArgs {
  bidder: string;
  bidTopic: string;
  bidId: string;
  awardDetails: string;
  bidderBalance: bigint;
}

// Create custom chains
const oevNetwork: OevChain = {
  id: 4913,
  name: "OEV Network",
  nativeCurrency: {
    decimals: 18,
    name: "ETH",
    symbol: "ETH",
  },
  rpcUrls: {
    default: {
      http: [process.env.OEV_NETWORK_RPC_URL!],
    },
    public: {
      http: [process.env.OEV_NETWORK_RPC_URL!],
    },
  },
};

const targetNetwork: Chain = {
  id: 100, // Replace with your Chain ID
  name: "Target Network",
  nativeCurrency: {
    decimals: 18,
    name: "ETH",
    symbol: "ETH",
  },
  rpcUrls: {
    default: {
      http: [process.env.TARGET_NETWORK_RPC_URL!],
    },
    public: {
      http: [process.env.TARGET_NETWORK_RPC_URL!],
    },
  },
};

// Create wallet accounts using a private key
const PRIVATE_KEY = process.env.PRIVATE_KEY ?? "";
const formattedPrivateKey: `0x${string}` = PRIVATE_KEY.startsWith("0x")
  ? (PRIVATE_KEY as `0x${string}`)
  : `0x${PRIVATE_KEY}`;

// Create wallet account
const account = privateKeyToAccount(formattedPrivateKey);

// Create clients
const oevNetworkPublic = createPublicClient({
  chain: oevNetwork,
  transport: http(),
});

const oevNetworkWallet = createWalletClient({
  account,
  chain: oevNetwork,
  transport: http(),
});

const targetNetworkPublic = createPublicClient({
  chain: targetNetwork,
  transport: http(),
});

const targetNetworkWallet = createWalletClient({
  account,
  chain: targetNetwork,
  transport: http(),
});

function determineSignedDataTimestampCutoff(): number {
  const hash = keccak256(encodeAbiParameters(parseAbiParameters("uint256"), [BigInt(DAPP_ID)]));
  const bigIntHash = BigInt(hash);
  const auctionOffset = Number(bigIntHash % BigInt(OEV_AUCTION_LENGTH_SECONDS));

  const currentTimestamp = Math.floor(Date.now() / 1000);
  const timeInCurrentAuction = (currentTimestamp - auctionOffset) % OEV_AUCTION_LENGTH_SECONDS;
  const auctionStartTimestamp = currentTimestamp - timeInCurrentAuction;
  const biddingPhaseEndTimestamp = auctionStartTimestamp + OEV_BIDDING_PHASE_LENGTH_SECONDS;
  let signedDataTimestampCutoff = auctionStartTimestamp + OEV_BIDDING_PHASE_LENGTH_SECONDS;

  if (biddingPhaseEndTimestamp - currentTimestamp < OEV_BIDDING_PHASE_BUFFER_SECONDS) {
    console.log(
      "Not enough time to place bid in current auction, bidding for the next one",
      currentTimestamp,
      biddingPhaseEndTimestamp,
      auctionOffset,
    );
    signedDataTimestampCutoff += OEV_AUCTION_LENGTH_SECONDS;
  }

  return signedDataTimestampCutoff;
}

function getBidTopic(signedDataTimestampCutoff: number): Hex {
  return keccak256(
    encodePacked(
      ["uint256", "uint256", "uint32", "uint32"],
      [
        BigInt(OEV_AUCTIONS_MAJOR_VERSION),
        BigInt(DAPP_ID),
        OEV_AUCTION_LENGTH_SECONDS,
        signedDataTimestampCutoff,
      ],
    ),
  );
}

function getBidDetails(OevFeedUpdaterAddress: Address): Hex {
  const nonce = toHex(crypto.getRandomValues(new Uint8Array(32)));
  return encodeAbiParameters(parseAbiParameters("address, bytes32"), [
    OevFeedUpdaterAddress,
    nonce,
  ]);
}

async function performOevUpdate(
  awardedSignature: Hex,
  signedDataTimestampCutoff: number,
  priceUpdateDetailsEncoded: Hex[],
): Promise<TransactionReceipt> {
  const PayBidAndUpdateFeeds: PayBidAndUpdateFeeds = {
    signedDataTimestampCutoff,
    signature: awardedSignature,
    bidAmount: parseEther(BID_AMOUNT),
    payOevBidCallbackData: {
      signedDataArray: priceUpdateDetailsEncoded,
    },
  };

  console.log("Performing Oracle update...");

  const OevFeedUpdater = getContract({
    address: deployments.OevFeedUpdater as Address,
    abi: OevFeedUpdaterABI,
    client: {
      public: targetNetworkPublic,
      wallet: targetNetworkWallet,
    },
  });

  // Estimate gas with a safety buffer
  let estimatedGas;
  try {
    estimatedGas = await targetNetworkPublic.estimateContractGas({
      address: deployments.OevFeedUpdater as Address,
      abi: OevFeedUpdaterABI,
      functionName: "payBidAndUpdateFeed",
      args: [PayBidAndUpdateFeeds],
      account: account.address,
      value: parseEther(BID_AMOUNT),
    });

    // Add a 30% buffer to the estimated gas
    estimatedGas = (estimatedGas * 130n) / 100n;
    console.log(`Estimated gas with 30% buffer: ${estimatedGas}`);
  } catch (error) {
    console.log("Gas estimation failed, using fallback gas limit");
    // Fallback to a reasonably high value if estimation fails
    estimatedGas = 3000000n;
  }

  // Get current fee data
  const feeData = await targetNetworkPublic.estimateFeesPerGas();

  const updateHash = await OevFeedUpdater.write.payBidAndUpdateFeed([PayBidAndUpdateFeeds], {
    value: parseEther(BID_AMOUNT),
    gas: estimatedGas,
    // Use appropriate fee values if available, otherwise use defaults
    ...(feeData.maxFeePerGas && {
      maxFeePerGas: feeData.maxFeePerGas,
      maxPriorityFeePerGas: feeData.maxPriorityFeePerGas || parseGwei("1"),
    }),
    // Fallback to gasPrice if EIP-1559 not available
    ...(!feeData.maxFeePerGas && {
      gasPrice: await targetNetworkPublic.getGasPrice(),
    }),
  });

  console.log("Oracle update sent, Tx Hash:", updateHash);
  const updateReceipt = await targetNetworkPublic.waitForTransactionReceipt({
    hash: updateHash,
  });
  console.log("Oracle update confirmed, used gas:", updateReceipt.gasUsed.toString());
  return updateReceipt;
}
async function reportFulfillment(
  updateTx: TransactionReceipt,
  bidTopic: Hex,
  bidDetails: Hex,
  bidId: Hex,
): Promise<any> {
  const OevAuctionHouse = getContract({
    address: deploymentAddresses.OevAuctionHouse["4913"] as Address,
    abi: OevAuctionHouseABI,
    client: {
      public: oevNetworkPublic,
      wallet: oevNetworkWallet,
    },
  });

  const bidDetailsHash = keccak256(bidDetails);

  const reportHash = await OevAuctionHouse.write.reportFulfillment([
    bidTopic,
    bidDetailsHash,
    updateTx.transactionHash,
  ]);

  await oevNetworkPublic.waitForTransactionReceipt({ hash: reportHash });
  console.log("Oracle update reported");

  const confirmedFulfillmentTx = await new Promise<any>(async (resolve, reject) => {
    console.log("Waiting for confirmation of fulfillment...");

    while (true) {
      const currentBlock = await oevNetworkPublic.getBlockNumber();
      const fromBlock = currentBlock - 10n;

      const logs = await oevNetworkPublic.getLogs({
        address: deploymentAddresses.OevAuctionHouse["4913"] as Address,
        event: parseAbiItem(
          "event ConfirmedFulfillment(address indexed bidder, bytes32 indexed bidTopic, bytes32 indexed bidId, uint256 bidderBalance, uint256 accumulatedProtocolFees)",
        ),
        fromBlock,
        toBlock: currentBlock,
        args: {
          bidTopic,
          bidId,
        },
      });

      if (logs.length > 0) {
        console.log("Confirmed Fulfillment", logs[0].transactionHash);
        resolve(logs);
        break;
      }
      // Sleep for 0.1 second
      await new Promise((r) => setTimeout(r, 100));
    }
  });

  return confirmedFulfillmentTx;
}

async function placeBid(): Promise<void> {
  // Fetch the OEV signed data to bid on
  const { priceUpdateDetailsEncoded, medianPrice } = await fetchOEVSignedData(DAPI_NAME);

  const targetChainId = await targetNetworkPublic.getChainId();

  const OevAuctionHouse = getContract({
    address: deploymentAddresses.OevAuctionHouse["4913"] as Address,
    abi: OevAuctionHouseABI,
    client: {
      public: oevNetworkPublic,
      wallet: oevNetworkWallet,
    },
  });

  const signedDataTimestampCutoff = determineSignedDataTimestampCutoff();
  const nextBiddingPhaseEndTimestamp = signedDataTimestampCutoff + OEV_AUCTION_LENGTH_SECONDS;

  const bidTopic = getBidTopic(signedDataTimestampCutoff);
  const bidDetails = getBidDetails(deployments.OevFeedUpdater as Address); // get this address from deployments

  console.log("Placing bid with the following details:");
  console.log("Bid Topic:", bidTopic);
  console.log("Bid Details:", bidDetails);
  console.log("Current Timestamp:", Math.floor(Date.now() / 1000));
  console.log("Signed Data Timestamp Cutoff:", signedDataTimestampCutoff);
  console.log("Next Bidding Phase End Timestamp:", nextBiddingPhaseEndTimestamp);

  // Placing our bid with the auction house on OEV network
  const placedbidTxHash = await OevAuctionHouse.write.placeBidWithExpiration([
    bidTopic,
    BigInt(targetChainId),
    parseEther(BID_AMOUNT),
    bidDetails,
    maxUint256, // Collateral Basis Points set to 0
    maxUint256, // Protocol Fee Basis Points set to 0
    nextBiddingPhaseEndTimestamp,
  ]);

  console.log("Bid Tx Hash", placedbidTxHash);
  console.log("Bid placed");

  // Wait for transaction receipt
  const bidReceipt = await oevNetworkPublic.waitForTransactionReceipt({
    hash: placedbidTxHash,
  });

  // Compute the bid ID
  const bidId = keccak256(
    concat([
      account.address, // address (20 bytes)
      bidTopic, // bytes32 (32 bytes)
      keccak256(bidDetails), // hash of bidDetails (32 bytes)
    ]),
  );

  const awardedSignature = await new Promise<Hex>(async (resolve, reject) => {
    console.log("Waiting for bid to be awarded...");

    while (true) {
      const bid = (await OevAuctionHouse.read.bids([bidId])) as readonly [
        bigint, // status
        Address, // bidder
        bigint, // bidAmount
        number, // signedDataTimestampCutoff
        bigint, // chainId
        bigint, // collateralAmount
        bigint, // protocolFeeAmount
      ];

      const status = bid[0];

      if (BigInt(status) === 2n) {
        console.log("Bid Awarded");
        const currentBlock = await oevNetworkPublic.getBlockNumber();
        const fromBlock = currentBlock - 10n;

        const logs = await oevNetworkPublic.getLogs({
          address: deploymentAddresses.OevAuctionHouse["4913"] as Address,
          event: parseAbiItem(
            "event AwardedBid(address indexed bidder, bytes32 indexed bidTopic, bytes32 indexed bidId, bytes awardDetails, uint256 bidderBalance)",
          ),
          fromBlock,
          toBlock: currentBlock,
          args: {
            bidTopic,
            bidId,
          },
        });

        if (logs.length > 0) {
          const decodedLog = decodeEventLog({
            abi: OevAuctionHouseABI,
            data: logs[0].data,
            topics: logs[0].topics,
          });

          // Get signature from event args
          if (decodedLog.eventName === "AwardedBid" && decodedLog.args) {
            const eventArgs = decodedLog.args as unknown as AwardedBidEventArgs;
            const signature = eventArgs.awardDetails as Hex;
            resolve(signature);
            break;
          }
        }
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  });

  const priceUpdateArray: Hex[] = priceUpdateDetailsEncoded;
  const updateTx = await performOevUpdate(
    awardedSignature,
    signedDataTimestampCutoff,
    priceUpdateArray,
  );

  const reportTx = await reportFulfillment(updateTx, bidTopic, bidDetails, bidId);
}

placeBid().catch(console.error);

export class LiquidationBot {
  private chainId: number;
  private client: Client<Transport, Chain, Account>;
  private morphoAddress: Address;
  private vaultWhitelist: Address[];
  private additionalMarketsWhitelist: Hex[];
  private executorAddress: Address;
  private liquidationVenues: LiquidityVenue[];

  constructor(
    chainId: number,
    client: Client<Transport, Chain, Account>,
    morphoAddress: Address,
    vaultWhitelist: Address[],
    additionalMarketsWhitelist: Hex[],
    executorAddress: Address,
    liquidationVenues: LiquidityVenue[],
  ) {
    this.chainId = chainId;
    this.client = client;
    this.vaultWhitelist = vaultWhitelist;
    this.additionalMarketsWhitelist = additionalMarketsWhitelist;
    this.morphoAddress = morphoAddress;
    this.executorAddress = executorAddress;
    this.liquidationVenues = liquidationVenues;
  }

  async run() {
    const { client } = this;
    const { vaultWhitelist } = this;
    const whitelistedMarketsFromVaults = [
      ...new Set(
        (
          await Promise.all(
            vaultWhitelist.map((vault) => fetchWhiteListedMarketsForVault(this.chainId, vault)),
          )
        ).flat(),
      ),
    ];

    const whitelistedMarkets = [
      ...whitelistedMarketsFromVaults,
      ...this.additionalMarketsWhitelist,
    ];

    const liquidatablePositions = await fetchLiquidatablePositions(
      this.chainId,
      whitelistedMarkets,
    );

    const executorAddress = this.executorAddress;

    await Promise.all(
      liquidatablePositions.map(async (liquidatablePosition) => {
        const { marketParams } = liquidatablePosition;

        let toConvert = {
          src: getAddress(marketParams.collateralToken),
          dst: getAddress(marketParams.loanToken),
          srcAmount: liquidatablePosition.seizableCollateral,
        };

        const encoder = new ExecutorEncoder(executorAddress, client);

        /// LIQUIDITY VENUES

        for (const venue of this.liquidationVenues) {
          if (await venue.supportsRoute(encoder, toConvert.src, toConvert.dst))
            toConvert = await venue.convert(encoder, toConvert);

          if (toConvert.src === toConvert.dst || toConvert.srcAmount === 0n) break;
        }

        if (toConvert.src !== toConvert.dst) return;

        encoder.erc20Approve(marketParams.loanToken, this.morphoAddress, maxUint256);

        encoder.morphoBlueLiquidate(
          this.morphoAddress,
          marketParams,
          liquidatablePosition.position.user,
          liquidatablePosition.seizableCollateral,
          0n,
          encoder.flush(),
        );

        const calls = encoder.flush();

        try {
          /// TX SIMULATION

          const populatedTx = {
            to: encoder.address,
            data: encodeFunctionData({
              abi: executorAbi,
              functionName: "exec_606BaXt",
              args: [calls],
            }),
            value: 0n, // TODO: find a way to get encoder value
          };

          const gasLimit = await estimateGas(client, populatedTx);

          // TX EXECUTION

          await writeContract(client, {
            address: encoder.address,
            abi: executorAbi,
            functionName: "exec_606BaXt",
            args: [calls],
          });

          console.log(
            `Liquidated ${liquidatablePosition.position.user} on ${liquidatablePosition.position.marketId}`,
          );
        } catch (error) {
          console.log(
            `Failed to liquidate ${liquidatablePosition.position.user} on ${liquidatablePosition.position.marketId}`,
          );
          console.error("liquidation error", error);
        }
      }),
    );
  }
}
