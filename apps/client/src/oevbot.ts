import {
    encodeFunctionData,
    getAddress,
    maxUint256,
    type Account,
    type Address,
    type Chain,
    type Client,
    type Hex,
    type Transport,
  } from "viem";
  import { estimateGas, writeContract } from "viem/actions";
  import { executorAbi, ExecutorEncoder } from "executooor-viem";
  
  import { fetchLiquidatablePositions, fetchWhiteListedMarketsForVault } from "./utils/fetchers.js";
  import type { LiquidityVenue } from "./liquidityVenues/liquidityVenue.js";
  
  // Add OEV related interfaces
  interface OevBidParams {
    signedDataTimestampCutoff: number;
    signature: Hex;
    bidAmount: bigint;
    signedDataArray: Hex[];
  }
  
  export class LiquidationBot {
    private chainId: number;
    private client: Client<Transport, Chain, Account>;
    private morphoAddress: Address;
    private vaultWhitelist: Address[];
    private additionalMarketsWhitelist: Hex[];
    private executorAddress: Address;
    private liquidationVenues: LiquidityVenue[];
    private oevContractAddress: Address; // Add OEV contract address
    private oevContractAbi: any; // Add OEV contract ABI
    private flashLoanProvider: Address; // Add flashloan provider address
    private useOev: boolean; // Flag to use OEV or not
  
    constructor(
      chainId: number,
      client: Client<Transport, Chain, Account>,
      morphoAddress: Address,
      vaultWhitelist: Address[],
      additionalMarketsWhitelist: Hex[],
      executorAddress: Address,
      liquidationVenues: LiquidityVenue[],
      oevContractAddress: Address,
      oevContractAbi: any,
      flashLoanProvider: Address,
      useOev: boolean = false
    ) {
      this.chainId = chainId;
      this.client = client;
      this.vaultWhitelist = vaultWhitelist;
      this.additionalMarketsWhitelist = additionalMarketsWhitelist;
      this.morphoAddress = morphoAddress;
      this.executorAddress = executorAddress;
      this.liquidationVenues = liquidationVenues;
      this.oevContractAddress = oevContractAddress;
      this.oevContractAbi = oevContractAbi;
      this.flashLoanProvider = flashLoanProvider;
      this.useOev = useOev;
    }
  
    // Function to execute the liquidation through OEV
    async executeWithOev(
      liquidatablePosition: any,
      executorCalls: Hex[],
      oevBidParams: OevBidParams
    ) {
      const { client } = this;
      
      try {
        await writeContract(client, {
          address: this.oevContractAddress,
          abi: this.oevContractAbi,
          functionName: "payBidAndUpdateFeed",
          args: [{
            signedDataTimestampCutoff: oevBidParams.signedDataTimestampCutoff,
            signature: oevBidParams.signature,
            bidAmount: oevBidParams.bidAmount,
            payOevBidCallbackData: {
              signedDataArray: oevBidParams.signedDataArray,
              executorCalls: executorCalls
            }
          }],
          value: oevBidParams.bidAmount // Pay the bid
        });
  
        console.log(
          `OEV Liquidated ${liquidatablePosition.position.user} on ${liquidatablePosition.position.marketId}`
        );
      } catch (error) {
        console.log(
          `OEV Failed to liquidate ${liquidatablePosition.position.user} on ${liquidatablePosition.position.marketId}`
        );
        console.error("OEV liquidation error", error);
      }
    }
  
    // Execute liquidation directly through executor
    async executeWithExecutor(
      liquidatablePosition: any,
      executorCalls: Hex[]
    ) {
      const { client } = this;
      
      try {
        const populatedTx = {
          to: this.executorAddress,
          data: encodeFunctionData({
            abi: executorAbi,
            functionName: "exec_606BaXt",
            args: [executorCalls],
          }),
          value: 0n,
        };
  
        const gasLimit = await estimateGas(client, populatedTx);
  
        await writeContract(client, {
          address: this.executorAddress,
          abi: executorAbi,
          functionName: "exec_606BaXt",
          args: [executorCalls],
        });
  
        console.log(
          `Direct Liquidated ${liquidatablePosition.position.user} on ${liquidatablePosition.position.marketId}`
        );
      } catch (error) {
        console.log(
          `Direct Failed to liquidate ${liquidatablePosition.position.user} on ${liquidatablePosition.position.marketId}`
        );
        console.error("Direct liquidation error", error);
      }
    }
  
    // Create liquidation calls including flash loan
    async createLiquidationCalls(liquidatablePosition: any): Promise<Hex[]> {
      const { marketParams } = liquidatablePosition;
      const encoder = new ExecutorEncoder(this.executorAddress, this.client);
      
      // Setup flashloan from a protocol (e.g., Aave, Morpho)
      // Here we're using Morpho Blue's flashloan
      const flashLoanAmount = liquidatablePosition.repayableDebt;
      const loanAsset = getAddress(marketParams.loanToken);
      
      // Create inner calls that will happen within the flash loan callback
      const innerCalls: Hex[] = [];
      
      // 1. Approve Morpho to spend the loan token for liquidation
      innerCalls.push(
        encoder.buildErc20Approve(loanAsset, this.morphoAddress, flashLoanAmount)
      );
      
      // 2. Execute the liquidation
      innerCalls.push(
        encoder.buildCall(
          this.morphoAddress,
          0n,
          encodeFunctionData({
            abi: [
              {
                inputs: [
                  {
                    name: "marketParams",
                    type: "tuple",
                    components: [
                      { name: "loanToken", type: "address" },
                      { name: "collateralToken", type: "address" },
                      { name: "oracle", type: "address" },
                      { name: "irm", type: "address" },
                      { name: "lltv", type: "uint256" },
                    ],
                  },
                  { name: "borrower", type: "address" },
                  { name: "seizedAssets", type: "uint256" },
                  { name: "repaidShares", type: "uint256" },
                  { name: "data", type: "bytes" },
                ],
                name: "liquidate",
                outputs: [],
                stateMutability: "nonpayable",
                type: "function",
              },
            ],
            functionName: "liquidate",
            args: [
              marketParams,
              liquidatablePosition.position.user,
              liquidatablePosition.seizableCollateral,
              0n,
              "0x",
            ],
          })
        )
      );
      
      // 3. Swap collateral back to loan token (if needed)
      let toConvert = {
        src: getAddress(marketParams.collateralToken),
        dst: getAddress(marketParams.loanToken),
        srcAmount: liquidatablePosition.seizableCollateral,
      };
      
      for (const venue of this.liquidationVenues) {
        if (await venue.supportsRoute(encoder, toConvert.src, toConvert.dst)) {
          const result = await venue.convert(encoder, toConvert);
          
          // Capture the swap call
          const swapCalls = encoder.flush();
          innerCalls.push(...swapCalls);
          
          toConvert = result;
        }
        
        if (toConvert.src === toConvert.dst || toConvert.srcAmount === 0n) break;
      }
      
      // 4. Approve flashloan provider to take back the loan
      innerCalls.push(
        encoder.buildErc20Approve(loanAsset, this.flashLoanProvider, flashLoanAmount)
      );
      
      // Now create the flash loan call with all inner calls as callback
      encoder.blueFlashLoan(
        this.flashLoanProvider,
        loanAsset,
        flashLoanAmount,
        innerCalls
      );
      
      // Return all calls
      return encoder.flush();
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
  
      // Process liquidatable positions
      await Promise.all(
        liquidatablePositions.map(async (liquidatablePosition) => {
          // Create liquidation calls including flash loan
          const executorCalls = await this.createLiquidationCalls(liquidatablePosition);
          
          // Check if we should use OEV
          if (this.useOev) {
            // In a real scenario, you would fetch OEV bid params from an API or build them
            const oevBidParams: OevBidParams = await this.fetchOevBidParams(liquidatablePosition);
            
            // Execute with OEV if we have valid bid params
            if (oevBidParams) {
              await this.executeWithOev(liquidatablePosition, executorCalls, oevBidParams);
            } else {
              // Fall back to direct execution if no OEV available
              await this.executeWithExecutor(liquidatablePosition, executorCalls);
            }
          } else {
            // Direct execution without OEV
            await this.executeWithExecutor(liquidatablePosition, executorCalls);
          }
        }),
      );
    }
    
    // Mock function to fetch OEV bid params
    // In a real scenario, you would get these from an API or build them
    async fetchOevBidParams(liquidatablePosition: any): Promise<OevBidParams | null> {
      // Implement your logic to get OEV bid params
      // This would typically involve:
      // 1. Checking if there's an OEV opportunity for this position
      // 2. Getting a signed data packet from an API3 Airnode or similar
      // 3. Calculating a bid amount based on expected profit
      
      // Mock implementation
      return {
        signedDataTimestampCutoff: Math.floor(Date.now() / 1000) + 60, // 1 minute from now
        signature: "0x123..." as Hex, // This would be a real signature in production
        bidAmount: 10000000000000000n, // 0.01 ETH as example
        signedDataArray: ["0x456..."] as Hex[], // This would be real signed data in production
      };
    }
  }