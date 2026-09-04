// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import { IERC20, ISwapRouter, ITokenMessengerV2, IWETH, SafeToken } from "./Interfaces.sol";

/// @notice Mainnet-only POC entry. Converts ETH/WBTC to USDC when necessary and starts CCTP V2.
/// @dev The final Ethereum recipient is deliberately absent from this transaction.
contract PrivacyEntryRouter {
    using SafeToken for IERC20;

    enum InputAsset {
        ETH,
        USDC,
        WBTC
    }

    struct EntryIntent {
        bytes32 flowId;
        InputAsset inputAsset;
        uint256 amountIn;
        uint256 minimumUsdc;
        uint24 poolFee;
        uint256 starknetRecipient;
        uint256 cctpMaxFee;
        uint32 minFinalityThreshold;
        uint256 deadline;
    }

    error AlreadyStarted(bytes32 flowId);
    error BadAmount();
    error BadDeadline();
    error BadRecipient();
    error InsufficientOutput(uint256 received, uint256 minimum);
    error ReentrantCall();
    error UnsupportedPoolFee();

    event EntryStarted(
        bytes32 indexed flowId,
        address indexed sender,
        InputAsset indexed inputAsset,
        uint256 inputAmount,
        uint256 usdcBurned,
        uint256 starknetRecipient
    );

    uint32 public constant STARKNET_DOMAIN = 25;
    IERC20 public immutable usdc;
    IERC20 public immutable wbtc;
    IWETH public immutable weth;
    ISwapRouter public immutable swapRouter;
    ITokenMessengerV2 public immutable tokenMessenger;

    mapping(bytes32 flowId => bool started) public started;
    uint256 private locked = 1;

    constructor(address usdc_, address wbtc_, address weth_, address swapRouter_, address messenger_) {
        if (
            usdc_ == address(0) || wbtc_ == address(0) || weth_ == address(0)
                || swapRouter_ == address(0) || messenger_ == address(0)
        ) revert BadRecipient();
        usdc = IERC20(usdc_);
        wbtc = IERC20(wbtc_);
        weth = IWETH(weth_);
        swapRouter = ISwapRouter(swapRouter_);
        tokenMessenger = ITokenMessengerV2(messenger_);
    }

    modifier nonReentrant() {
        if (locked != 1) revert ReentrantCall();
        locked = 2;
        _;
        locked = 1;
    }

    function start(EntryIntent calldata intent) external payable nonReentrant returns (uint256 usdcAmount) {
        if (started[intent.flowId]) revert AlreadyStarted(intent.flowId);
        if (intent.amountIn == 0 || intent.minimumUsdc == 0 || intent.cctpMaxFee >= intent.minimumUsdc) {
            revert BadAmount();
        }
        if (intent.starknetRecipient == 0) revert BadRecipient();
        if (intent.deadline < block.timestamp) revert BadDeadline();
        if (intent.inputAsset != InputAsset.USDC && !_supportedFee(intent.poolFee)) {
            revert UnsupportedPoolFee();
        }

        started[intent.flowId] = true;
        usdcAmount = _collectAndSwap(intent);
        if (usdcAmount < intent.minimumUsdc) {
            revert InsufficientOutput(usdcAmount, intent.minimumUsdc);
        }

        usdc.forceApprove(address(tokenMessenger), usdcAmount);
        // Circle's Forwarding Service does not support Starknet as a destination. A sponsored
        // backend relayer submits receive_message on Starknet after Iris attests this burn.
        tokenMessenger.depositForBurn(
            usdcAmount,
            STARKNET_DOMAIN,
            bytes32(intent.starknetRecipient),
            address(usdc),
            bytes32(0),
            intent.cctpMaxFee,
            intent.minFinalityThreshold
        );
        usdc.forceApprove(address(tokenMessenger), 0);

        emit EntryStarted(
            intent.flowId,
            msg.sender,
            intent.inputAsset,
            intent.amountIn,
            usdcAmount,
            intent.starknetRecipient
        );
    }

    function _collectAndSwap(EntryIntent calldata intent) private returns (uint256) {
        if (intent.inputAsset == InputAsset.USDC) {
            if (msg.value != 0) revert BadAmount();
            usdc.safeTransferFrom(msg.sender, address(this), intent.amountIn);
            return intent.amountIn;
        }

        IERC20 input;
        if (intent.inputAsset == InputAsset.ETH) {
            if (msg.value != intent.amountIn) revert BadAmount();
            weth.deposit{ value: msg.value }();
            input = IERC20(address(weth));
        } else {
            if (msg.value != 0) revert BadAmount();
            wbtc.safeTransferFrom(msg.sender, address(this), intent.amountIn);
            input = wbtc;
        }

        input.forceApprove(address(swapRouter), intent.amountIn);
        uint256 amountOut = swapRouter.exactInputSingle(
            ISwapRouter.ExactInputSingleParams({
                tokenIn: address(input),
                tokenOut: address(usdc),
                fee: intent.poolFee,
                recipient: address(this),
                deadline: intent.deadline,
                amountIn: intent.amountIn,
                amountOutMinimum: intent.minimumUsdc,
                sqrtPriceLimitX96: 0
            })
        );
        input.forceApprove(address(swapRouter), 0);
        return amountOut;
    }

    function _supportedFee(uint24 fee) private pure returns (bool) {
        return fee == 100 || fee == 500 || fee == 3_000 || fee == 10_000;
    }
}
