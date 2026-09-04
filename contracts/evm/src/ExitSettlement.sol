// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import { IERC20, ISwapRouter, IWETH, SafeToken } from "./Interfaces.sol";

/// @notice One immutable recipient-bound contract per private exit.
/// @dev It is deployed only after the privacy delay, so the entry transaction cannot reveal the recipient.
contract ExitSettlement {
    using SafeToken for IERC20;

    enum OutputAsset {
        ETH,
        USDC,
        WBTC
    }

    error AlreadySettled();
    error BadConfiguration();
    error EmptyBalance();
    error RecoveryNotReady();
    error ReentrantCall();
    error EthTransferFailed();

    event Settled(address indexed recipient, OutputAsset indexed asset, uint256 inputUsdc, uint256 output);
    event RecoveredAsUsdc(address indexed recipient, uint256 amount);

    IERC20 public immutable usdc;
    IERC20 public immutable wbtc;
    IWETH public immutable weth;
    ISwapRouter public immutable swapRouter;
    address payable public immutable recipient;
    OutputAsset public immutable outputAsset;
    uint256 public immutable minimumOutput;
    uint24 public immutable poolFee;
    uint64 public immutable recoverAfter;

    bool public settled;
    uint256 private locked = 1;

    constructor(
        address usdc_,
        address wbtc_,
        address weth_,
        address swapRouter_,
        address payable recipient_,
        OutputAsset outputAsset_,
        uint256 minimumOutput_,
        uint24 poolFee_,
        uint64 recoverAfter_
    ) {
        if (
            usdc_ == address(0) || wbtc_ == address(0) || weth_ == address(0)
                || swapRouter_ == address(0) || recipient_ == address(0) || recoverAfter_ <= block.timestamp
        ) revert BadConfiguration();
        usdc = IERC20(usdc_);
        wbtc = IERC20(wbtc_);
        weth = IWETH(weth_);
        swapRouter = ISwapRouter(swapRouter_);
        recipient = recipient_;
        outputAsset = outputAsset_;
        minimumOutput = minimumOutput_;
        poolFee = poolFee_;
        recoverAfter = recoverAfter_;
    }

    modifier nonReentrant() {
        if (locked != 1) revert ReentrantCall();
        locked = 2;
        _;
        locked = 1;
    }

    /// @notice Permissionless final settlement after CCTP has minted USDC here.
    function settle() external nonReentrant returns (uint256 output) {
        if (settled) revert AlreadySettled();
        uint256 amount = usdc.balanceOf(address(this));
        if (amount == 0) revert EmptyBalance();
        settled = true;

        if (outputAsset == OutputAsset.USDC) {
            usdc.safeTransfer(recipient, amount);
            output = amount;
        } else {
            address tokenOut = outputAsset == OutputAsset.WBTC ? address(wbtc) : address(weth);
            usdc.forceApprove(address(swapRouter), amount);
            output = swapRouter.exactInputSingle(
                ISwapRouter.ExactInputSingleParams({
                    tokenIn: address(usdc),
                    tokenOut: tokenOut,
                    fee: poolFee,
                    recipient: address(this),
                    deadline: block.timestamp,
                    amountIn: amount,
                    amountOutMinimum: minimumOutput,
                    sqrtPriceLimitX96: 0
                })
            );
            usdc.forceApprove(address(swapRouter), 0);

            if (outputAsset == OutputAsset.WBTC) {
                wbtc.safeTransfer(recipient, output);
            } else {
                weth.withdraw(output);
                (bool ok,) = recipient.call{ value: output }("");
                if (!ok) revert EthTransferFailed();
            }
        }

        emit Settled(recipient, outputAsset, amount, output);
    }

    /// @notice Safe fallback if the requested output swap cannot satisfy its fixed slippage floor.
    function recoverAsUsdc() external nonReentrant {
        if (settled) revert AlreadySettled();
        if (block.timestamp < recoverAfter) revert RecoveryNotReady();
        uint256 amount = usdc.balanceOf(address(this));
        if (amount == 0) revert EmptyBalance();
        settled = true;
        usdc.safeTransfer(recipient, amount);
        emit RecoveredAsUsdc(recipient, amount);
    }

    receive() external payable {
        if (msg.sender != address(weth)) revert EthTransferFailed();
    }
}
