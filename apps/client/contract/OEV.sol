// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IApi3ServerV1OevExtension} from "@api3/contracts/api3-server-v1/interfaces/IApi3ServerV1OevExtension.sol";
import {IApi3ServerV1OevExtensionOevBidPayer} from "@api3/contracts/api3-server-v1/interfaces/IApi3ServerV1OevExtensionOevBidPayer.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IExecutor} from "./interfaces/IExecutor.sol";

contract MorphoOevLiquidator is Ownable, IApi3ServerV1OevExtensionOevBidPayer {
    uint256 public immutable dappId;
    IApi3ServerV1OevExtension public immutable api3ServerV1OevExtension;
    IExecutor public immutable executor;

    bytes32 private constant OEV_BID_PAYMENT_CALLBACK_SUCCESS =
        keccak256("Api3ServerV1OevExtensionOevBidPayer.onOevBidPayment");

    struct PayBidAndUpdateFeeds {
        uint32 signedDataTimestampCutoff;
        bytes signature;
        uint256 bidAmount;
        PayOevBidCallbackData payOevBidCallbackData;
    }

    struct PayOevBidCallbackData {
        bytes[] signedDataArray;
        bytes[] executorCalls; // Pre-encoded calls for the executor
    }

    event LiquidationExecuted(address indexed executor, uint256 callsExecuted);

    constructor(
        uint256 _dappId,
        address _api3ServerV1OevExtension,
        address _executor
    ) Ownable() {
        dappId = _dappId;
        api3ServerV1OevExtension = IApi3ServerV1OevExtension(_api3ServerV1OevExtension);
        executor = IExecutor(_executor);
    }

    // This function is called by your off-chain system with the bid details and executor calls
    function payBidAndUpdateFeed(
        PayBidAndUpdateFeeds calldata params
    ) external payable {
        require(msg.value == params.bidAmount, "Incorrect bid amount");
        api3ServerV1OevExtension.payOevBid(
            dappId,
            params.bidAmount,
            params.signedDataTimestampCutoff,
            params.signature,
            abi.encode(params.payOevBidCallbackData)
        );
    }

    // This is called by the API3 OEV extension after payBidAndUpdateFeed
    function onOevBidPayment(
        uint256 bidAmount,
        bytes calldata _data
    ) external override returns (bytes32) {
        require(msg.sender == address(api3ServerV1OevExtension), "Unauthorized");

        PayOevBidCallbackData memory data = abi.decode(_data, (PayOevBidCallbackData));

        // First update the price feed
        api3ServerV1OevExtension.updateDappOevDataFeed(dappId, data.signedDataArray);

        // Execute the multicall through the Executor
        // This will handle the flashloan and liquidation
        executor.exec_606BaXt(data.executorCalls);

        // Pay the bid amount back to the OEV extension
        (bool success, ) = address(api3ServerV1OevExtension).call{value: bidAmount}("");
        require(success, "Bid payment failed");

        emit LiquidationExecuted(address(executor), data.executorCalls.length);

        return OEV_BID_PAYMENT_CALLBACK_SUCCESS;
    }

    // Function to approve tokens for the Executor to use
    function approveToken(address token, uint256 amount) external onlyOwner {
        IERC20(token).approve(address(executor), amount);
    }

    // Utility function to withdraw any profits
    function withdrawToken(address token, uint256 amount) external onlyOwner {
        IERC20(token).transfer(owner(), amount);
    }

    function withdrawETH(uint256 amount) external onlyOwner {
        payable(owner()).transfer(amount);
    }

    receive() external payable {}
}