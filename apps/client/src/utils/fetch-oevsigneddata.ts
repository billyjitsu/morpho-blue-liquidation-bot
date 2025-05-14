import {
  deploymentAddresses,
  Api3ServerV1__factory,
  AirseekerRegistry__factory,
} from "@api3/contracts";
import {
  createPublicClient,
  http,
  toHex,
  keccak256,
  encodeAbiParameters,
  parseAbiParameters,
  decodeAbiParameters,
  Address,
  Hex,
} from "viem";
import "dotenv/config";

interface PriceDetail {
  /** Airnode address */
  airnode: Address;
  /** Encoded value from the update */
  encodedValue: Hex;
  /** Signature for the update */
  signature: Hex;
  /** Template ID */
  templateId: Hex;
  /** OEV Template ID */
  templateIdOEV: string;
  /** Timestamp of the update */
  timestamp: string;
  /** Decoded price value in USD */
  decodedValue: number;
  /** Decoded timestamp as Date object */
  decodedtimestamp: Date;
}

/**
 * Encoded price update details
 */
type PriceUpdateDetailsEncoded = Hex;

/**
 * Structure of the API response from the signed API
 */
interface SignedApiResponse {
  data: Record<
    string,
    {
      templateId: string;
      timestamp: string;
      encodedValue: string;
      signature: string;
    }
  >;
}

/**
 * Derives the OEV template ID from a template ID
 * @param templateId - The template ID to derive from
 * @returns The derived OEV template ID
 */
function deriveOevTemplateId(templateId: Hex): Hex {
  return keccak256(templateId);
}

/**
 * Calculates the median price from a list of price details
 * @param priceDetails - Array of price details
 * @returns The median price
 */
function calculateMedianPrice(priceDetails: PriceDetail[]): number {
  const values = priceDetails.map((price) => price.decodedValue).sort((a, b) => a - b);
  const len = values.length;

  if (len === 0) return 0;

  if (len % 2 === 0) {
    // Even number of elements
    const lowerValue = values[len / 2 - 1];
    const upperValue = values[len / 2];

    // Use type guards to ensure values are defined
    if (lowerValue !== undefined && upperValue !== undefined) {
      return (lowerValue + upperValue) / 2;
    }
    return 0; // Fallback
  } else {
    // Odd number of elements
    const middleValue = values[Math.floor(len / 2)];
    return middleValue ?? 0;
  }
}

/**
 * Fetches OEV signed data for a given DAPI name
 * @param DAPI_NAME - The name of the DAPI
 * @returns Promise resolving to price update details and median price
 */
export async function fetchOEVSignedData(DAPI_NAME: string): Promise<{
  priceUpdateDetailsEncoded: PriceUpdateDetailsEncoded[];
  medianPrice: number;
}> {
  try {
    const RPC_URL = process.env.TARGET_NETWORK_RPC_URL;
    if (!RPC_URL) {
      throw new Error("RPC URL is not defined in environment variables");
    }

    // Create public client
    const publicClient = createPublicClient({
      transport: http(RPC_URL),
    });

    // Get chain ID
    const chainId = await publicClient.getChainId();
    const chainIdString = chainId.toString();

    // Get contract addresses
    const api3ServerV1Address =
      deploymentAddresses.Api3ServerV1[
        chainIdString as keyof typeof deploymentAddresses.Api3ServerV1
      ];
    if (!api3ServerV1Address) {
      throw new Error(`Api3ServerV1 not deployed on chain ID ${chainIdString}`);
    }

    const airseekerRegistryAddress =
      deploymentAddresses.AirseekerRegistry[
        chainIdString as keyof typeof deploymentAddresses.AirseekerRegistry
      ];
    if (!airseekerRegistryAddress) {
      throw new Error(`AirseekerRegistry not deployed on chain ID ${chainIdString}`);
    }

    // Convert addresses to the required viem format
    const api3ServerV1AddressHex = api3ServerV1Address as `0x${string}`;
    const airseekerRegistryAddressHex = airseekerRegistryAddress as `0x${string}`;

    console.log("Fetching OEV signed data for", DAPI_NAME);

    // Encode DAPI name as bytes32
    const encodedDapiName = toHex(DAPI_NAME.padEnd(32, "\0"), { size: 32 });
    console.log("Encoded Dapi Name:", encodedDapiName);

    // Hash encoded DAPI name
    const encodedDapiNameHash = keccak256(encodedDapiName);
    console.log("Encoded Dapi Name Hash:", encodedDapiNameHash);

    // Get data feed ID
    const dataFeedId = await publicClient.readContract({
      address: api3ServerV1AddressHex,
      abi: Api3ServerV1__factory.abi,
      functionName: "dapiNameHashToDataFeedId",
      args: [encodedDapiNameHash],
    });
    console.log("Data Feed ID:", dataFeedId);

    // Get data feed details
    const dataFeedDetails = await publicClient.readContract({
      address: airseekerRegistryAddressHex,
      abi: AirseekerRegistry__factory.abi,
      functionName: "dataFeedIdToDetails",
      args: [dataFeedId],
    });

    // Decode data feed details
    const [airnodes, templateIds] = decodeAbiParameters(
      parseAbiParameters("address[], bytes32[]"),
      dataFeedDetails,
    );

    const priceDetails: PriceDetail[] = [];

    // Process each airnode and template ID
    for (let i = 0; i < airnodes.length; i++) {
      const airnode = airnodes[i];
      const templateId = templateIds[i];

      // Skip iteration if either airnode or templateId is undefined
      if (!airnode || !templateId) {
        console.log(`Skipping index ${String(i)}: airnode or templateId is undefined`);
        continue;
      }

      const oevTemplateId = deriveOevTemplateId(templateId);

      try {
        const response = await fetch(`https://signed-api.api3.org/public-oev/${airnode}`);
        if (!response.ok) {
          throw new Error(`HTTP error! status: ${String(response.status)}`);
        }

        const data = (await response.json()) as SignedApiResponse;

        // Filter updates by template ID
        const relevantUpdates = Object.values(data.data).filter(
          (update) => update.templateId === oevTemplateId,
        );

        if (relevantUpdates.length > 0) {
          // Get latest update
          const latestUpdate = relevantUpdates.sort(
            (a, b) => parseInt(b.timestamp) - parseInt(a.timestamp),
          )[0];

          if (latestUpdate) {
            // Decode value from Wei to USD
            const decodedValueWei = BigInt(latestUpdate.encodedValue);
            const decodedValueUSD = Number(decodedValueWei) / 1e18;

            priceDetails.push({
              airnode: airnode,
              encodedValue: latestUpdate.encodedValue as Hex,
              signature: latestUpdate.signature as Hex,
              templateId: templateId,
              templateIdOEV: latestUpdate.templateId,
              timestamp: latestUpdate.timestamp,
              decodedValue: decodedValueUSD,
              decodedtimestamp: new Date(parseInt(latestUpdate.timestamp) * 1000),
            });
          }
        }
      } catch (error) {
        if (error instanceof Error) {
          console.log(`Error fetching data for airnode ${airnode}:`, error.message);
        } else {
          console.log(`Unknown error fetching data for airnode ${airnode}`);
        }
      }
    }

    const validPriceDetails = priceDetails.filter((detail) => {
      // Validate timestamp is a valid number
      const timestamp = parseInt(detail.timestamp);
      if (isNaN(timestamp)) {
        console.log(`Invalid timestamp for airnode ${detail.airnode}, skipping`);
        return false;
      }

      // Validate the encoded value is a valid hex
      if (!detail.encodedValue.startsWith("0x")) {
        console.log(`Invalid encodedValue for airnode ${detail.airnode}, skipping`);
        return false;
      }

      // Validate the signature is a valid hex
      if (!detail.signature.startsWith("0x")) {
        console.log(`Invalid signature for airnode ${detail.airnode}, skipping`);
        return false;
      }

      return true;
    });

    console.log(
      `Filtered from ${priceDetails.length.toString()} to ${validPriceDetails.length.toString()} valid price details`,
    );

    // Calculate median price from valid details
    const medianPrice = calculateMedianPrice(validPriceDetails);
    console.log("Median Price:", medianPrice);

    // Encode only valid price update details
    const priceUpdateDetailsEncoded = validPriceDetails.map((priceUpdate) => {
      const timestamp = BigInt(priceUpdate.timestamp);
      return encodeAbiParameters(parseAbiParameters("address, bytes32, uint256, bytes, bytes"), [
        priceUpdate.airnode,
        priceUpdate.templateId,
        timestamp,
        priceUpdate.encodedValue,
        priceUpdate.signature,
      ]);
    });

    return {
      priceUpdateDetailsEncoded,
      medianPrice,
    };
  } catch (error) {
    console.error("Error:", error);
    throw error;
  }
}
