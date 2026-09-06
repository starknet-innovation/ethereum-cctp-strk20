// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import { IERC20, ISwapRouter } from "../../src/Interfaces.sol";
import { ExitSettlement } from "../../src/ExitSettlement.sol";
import { ExitSettlementFactory } from "../../src/ExitSettlementFactory.sol";
import { PrivacyEntryRouter } from "../../src/PrivacyEntryRouter.sol";
import { Vm } from "./Vm.sol";

interface IQuoter {
    function quoteExactInputSingle(
        address tokenIn,
        address tokenOut,
        uint24 fee,
        uint256 amountIn,
        uint160 sqrtPriceLimitX96
    ) external returns (uint256 amountOut);
}

interface IERC20Supply {
    function totalSupply() external view returns (uint256);
}

/// @dev Mirrors packages/shared/src/constants.ts and docs/ARCHITECTURE.md. Keep them in sync.
library Mainnet {
    address constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address constant WBTC = 0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599;
    address constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address constant SWAP_ROUTER = 0xE592427A0AEce92De3Edee1F18E0157C05861564;
    address constant QUOTER = 0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6;
    address constant TOKEN_MESSENGER_V2 = 0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d;
    address constant MESSAGE_TRANSMITTER_V2 = 0x81D40F21F12A8F0E3252Bccb954D722d4c464B64;
    uint32 constant ETHEREUM_DOMAIN = 0;
    uint32 constant STARKNET_DOMAIN = 25;
    bytes32 constant STARKNET_TOKEN_MESSENGER_MINTER_V2 =
        0x07d421B9cA8aA32DF259965cDA8ACb93F7599F69209A41872AE84638B2A20F2a;
}

/// @notice End-to-end tests for the Ethereum leg against a fork of mainnet: real Uniswap V3 pools,
/// real USDC/WBTC/WETH and the real Circle CCTP V2 contracts. Skipped unless ETHEREUM_RPC_URL is set.
/// Run with `npm run test:fork` (optionally ETHEREUM_FORK_BLOCK to pin and cache a block).
contract MainnetRoundTripForkTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    bytes32 constant DEPOSIT_FOR_BURN_TOPIC = keccak256(
        "DepositForBurn(address,uint256,address,bytes32,uint32,bytes32,bytes32,uint256,uint32,bytes)"
    );
    bytes32 constant MESSAGE_SENT_TOPIC = keccak256("MessageSent(bytes)");
    uint32 constant FAST_FINALITY = 1_000;
    uint256 constant MESSAGE_LENGTH_WITHOUT_HOOK = 376;

    // Derived test fixtures, not real accounts. A felt must stay below 2^251.
    uint256 constant STARKNET_RECIPIENT = uint256(keccak256("ephemeral starknet account")) >> 8;
    address payable immutable recipient =
        payable(address(uint160(uint256(keccak256("fork recipient")))));
    address immutable relayer = address(uint160(uint256(keccak256("fork relayer"))));

    IERC20 constant usdc = IERC20(Mainnet.USDC);
    IERC20 constant wbtc = IERC20(Mainnet.WBTC);
    IERC20 constant weth = IERC20(Mainnet.WETH);

    struct Holdings {
        uint256 eth;
        uint256 usdc;
        uint256 weth;
        uint256 wbtc;
    }

    PrivacyEntryRouter entry;
    ExitSettlementFactory factory;
    /// @dev Deterministic Foundry addresses can already hold dust on mainnet; assert deltas.
    Holdings routerBaseline;

    receive() external payable { }

    function setUp() public {
        string memory url = vm.envOr("ETHEREUM_RPC_URL", string(""));
        if (bytes(url).length == 0) {
            vm.skip(true);
            return;
        }
        uint256 blockNumber = vm.envOr("ETHEREUM_FORK_BLOCK", uint256(0));
        if (blockNumber == 0) vm.createSelectFork(url);
        else vm.createSelectFork(url, blockNumber);

        entry = new PrivacyEntryRouter(
            Mainnet.USDC,
            Mainnet.WBTC,
            Mainnet.WETH,
            Mainnet.SWAP_ROUTER,
            Mainnet.TOKEN_MESSENGER_V2
        );
        factory =
            new ExitSettlementFactory(Mainnet.USDC, Mainnet.WBTC, Mainnet.WETH, Mainnet.SWAP_ROUTER);
        routerBaseline = _holdings(address(entry));
        vm.deal(address(this), 100 ether);
        vm.deal(relayer, 1 ether);
        vm.label(address(entry), "PrivacyEntryRouter");
        vm.label(address(factory), "ExitSettlementFactory");
        vm.label(recipient, "recipient");
        vm.label(relayer, "relayer");
    }

    // ---------------------------------------------------------------------------------------
    // Entry: Ethereum -> Circle burn for Starknet
    // ---------------------------------------------------------------------------------------

    function testEthEntrySwapsOnUniswapAndBurnsThroughCircle() public {
        uint256 amountIn = 0.1 ether;
        (uint256 quoted, uint24 fee) = _bestQuote(Mainnet.WETH, Mainnet.USDC, amountIn);
        PrivacyEntryRouter.EntryIntent memory intent = _intent(
            keccak256("eth"), PrivacyEntryRouter.InputAsset.ETH, amountIn, quoted * 99 / 100, fee
        );
        uint256 supplyBefore = IERC20Supply(Mainnet.USDC).totalSupply();
        uint256 ethBefore = address(this).balance;

        vm.recordLogs();
        uint256 burned = entry.start{ value: amountIn }(intent);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        require(burned >= intent.minimumUsdc, "swap below floor");
        require(address(this).balance == ethBefore - amountIn, "ETH not spent exactly");
        require(
            IERC20Supply(Mainnet.USDC).totalSupply() == supplyBefore - burned, "USDC not burned"
        );
        require(entry.started(intent.flowId), "flow not marked started");
        _assertRouterHoldsNothing();
        _assertDepositForBurn(logs, intent, burned);
        _assertCctpMessage(logs, intent, burned);
    }

    function testUsdcEntryBurnsTheExactAmount() public {
        uint256 amountIn = 100e6;
        _buyWithEth(Mainnet.USDC, 0.1 ether);
        require(usdc.balanceOf(address(this)) >= amountIn, "not enough USDC bought");
        usdc.approve(address(entry), amountIn);
        PrivacyEntryRouter.EntryIntent memory intent =
            _intent(keccak256("usdc"), PrivacyEntryRouter.InputAsset.USDC, amountIn, amountIn, 0);
        uint256 supplyBefore = IERC20Supply(Mainnet.USDC).totalSupply();

        vm.recordLogs();
        uint256 burned = entry.start(intent);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        require(burned == amountIn, "USDC entry must burn the exact input");
        require(
            IERC20Supply(Mainnet.USDC).totalSupply() == supplyBefore - amountIn, "USDC not burned"
        );
        require(usdc.allowance(address(this), address(entry)) == 0, "allowance not consumed");
        _assertRouterHoldsNothing();
        _assertDepositForBurn(logs, intent, burned);
        _assertCctpMessage(logs, intent, burned);
    }

    function testWbtcEntrySwapsOnUniswapAndBurnsThroughCircle() public {
        uint256 amountIn = 0.001e8;
        _buyWithEth(Mainnet.WBTC, 0.5 ether);
        require(wbtc.balanceOf(address(this)) >= amountIn, "not enough WBTC bought");
        (uint256 quoted, uint24 fee) = _bestQuote(Mainnet.WBTC, Mainnet.USDC, amountIn);
        wbtc.approve(address(entry), amountIn);
        PrivacyEntryRouter.EntryIntent memory intent = _intent(
            keccak256("wbtc"), PrivacyEntryRouter.InputAsset.WBTC, amountIn, quoted * 99 / 100, fee
        );
        uint256 wbtcBefore = wbtc.balanceOf(address(this));

        vm.recordLogs();
        uint256 burned = entry.start(intent);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        require(burned >= intent.minimumUsdc, "swap below floor");
        require(wbtc.balanceOf(address(this)) == wbtcBefore - amountIn, "WBTC not spent exactly");
        _assertRouterHoldsNothing();
        _assertDepositForBurn(logs, intent, burned);
        _assertCctpMessage(logs, intent, burned);
    }

    function testEntryRevertsWhenUniswapCannotMeetTheFloor() public {
        uint256 amountIn = 0.1 ether;
        (uint256 quoted, uint24 fee) = _bestQuote(Mainnet.WETH, Mainnet.USDC, amountIn);
        PrivacyEntryRouter.EntryIntent memory intent = _intent(
            keccak256("floor"), PrivacyEntryRouter.InputAsset.ETH, amountIn, quoted * 2, fee
        );
        vm.expectRevert();
        entry.start{ value: amountIn }(intent);
        require(!entry.started(intent.flowId), "failed entry must not mark the flow");
    }

    function testEntryRejectsAReplayedFlowId() public {
        uint256 amountIn = 0.05 ether;
        (uint256 quoted, uint24 fee) = _bestQuote(Mainnet.WETH, Mainnet.USDC, amountIn);
        PrivacyEntryRouter.EntryIntent memory intent = _intent(
            keccak256("replay"), PrivacyEntryRouter.InputAsset.ETH, amountIn, quoted * 99 / 100, fee
        );
        entry.start{ value: amountIn }(intent);
        vm.expectRevert(
            abi.encodeWithSelector(PrivacyEntryRouter.AlreadyStarted.selector, intent.flowId)
        );
        entry.start{ value: amountIn }(intent);
    }

    function testEntryRejectsMismatchedEthValue() public {
        uint256 amountIn = 0.05 ether;
        (uint256 quoted, uint24 fee) = _bestQuote(Mainnet.WETH, Mainnet.USDC, amountIn);
        PrivacyEntryRouter.EntryIntent memory intent = _intent(
            keccak256("value"), PrivacyEntryRouter.InputAsset.ETH, amountIn, quoted * 99 / 100, fee
        );
        vm.expectRevert(PrivacyEntryRouter.BadAmount.selector);
        entry.start{ value: amountIn - 1 }(intent);
    }

    // ---------------------------------------------------------------------------------------
    // Exit: settlement deployed after the delay, funded by the CCTP mint, paid to the recipient
    // ---------------------------------------------------------------------------------------

    function testFactoryPredictsTheCreate2Address() public {
        bytes32 salt = keccak256("predict");
        uint64 recoverAfter = uint64(block.timestamp + 1 hours);
        address predicted =
            factory.predict(salt, recipient, ExitSettlement.OutputAsset.USDC, 1, 500, recoverAfter);
        address created =
            factory.create(salt, recipient, ExitSettlement.OutputAsset.USDC, 1, 500, recoverAfter);
        require(created == predicted, "predict must equal create");
        require(factory.settlements(salt) == created, "salt not recorded");
        require(created.code.length > 0, "settlement has no code");
        vm.expectRevert(abi.encodeWithSelector(ExitSettlementFactory.DuplicateSalt.selector, salt));
        factory.create(salt, recipient, ExitSettlement.OutputAsset.USDC, 1, 500, recoverAfter);
    }

    function testSettlementSwapsUsdcToEthForTheRecipient() public {
        uint256 amount = 200e6;
        _buyWithEth(Mainnet.USDC, 0.2 ether);
        (uint256 quoted, uint24 fee) = _bestQuote(Mainnet.USDC, Mainnet.WETH, amount);
        uint256 minimumOutput = quoted * 99 / 100;
        ExitSettlement settlement = _createSettlement(
            keccak256("eth-out"), ExitSettlement.OutputAsset.ETH, minimumOutput, fee
        );
        usdc.transfer(address(settlement), amount);
        uint256 before = recipient.balance;
        Holdings memory settlementBefore = _holdings(address(settlement));

        vm.prank(relayer);
        uint256 output = settlement.settle();

        require(output >= minimumOutput, "output below floor");
        require(recipient.balance - before == output, "recipient did not receive the ETH output");
        Holdings memory settlementAfter = _holdings(address(settlement));
        require(settlementAfter.usdc == settlementBefore.usdc - amount, "USDC left in settlement");
        require(settlementAfter.weth == settlementBefore.weth, "WETH left in settlement");
        require(settlementAfter.eth == settlementBefore.eth, "ETH left in settlement");
        require(settlement.settled(), "not marked settled");
        vm.expectRevert(ExitSettlement.AlreadySettled.selector);
        settlement.settle();
    }

    function testSettlementSwapsUsdcToWbtcForTheRecipient() public {
        uint256 amount = 200e6;
        _buyWithEth(Mainnet.USDC, 0.2 ether);
        (uint256 quoted, uint24 fee) = _bestQuote(Mainnet.USDC, Mainnet.WBTC, amount);
        uint256 minimumOutput = quoted * 99 / 100;
        ExitSettlement settlement = _createSettlement(
            keccak256("wbtc-out"), ExitSettlement.OutputAsset.WBTC, minimumOutput, fee
        );
        usdc.transfer(address(settlement), amount);
        uint256 before = wbtc.balanceOf(recipient);

        vm.prank(relayer);
        uint256 output = settlement.settle();

        require(output >= minimumOutput, "output below floor");
        require(wbtc.balanceOf(recipient) - before == output, "recipient did not receive WBTC");
        require(usdc.balanceOf(address(settlement)) == 0, "USDC left in settlement");
        require(settlement.settled(), "not marked settled");
    }

    function testSettlementPaysUsdcDirectly() public {
        uint256 amount = 150e6;
        _buyWithEth(Mainnet.USDC, 0.2 ether);
        ExitSettlement settlement = _createSettlement(
            keccak256("usdc-out"), ExitSettlement.OutputAsset.USDC, amount * 99 / 100, 500
        );
        usdc.transfer(address(settlement), amount);

        vm.prank(relayer);
        uint256 output = settlement.settle();

        require(output == amount, "USDC output must be the full balance");
        require(usdc.balanceOf(recipient) == amount, "recipient did not receive USDC");
        require(settlement.settled(), "not marked settled");
    }

    function testSettlementFallsBackToUsdcRecoveryAfterTheWindow() public {
        uint256 amount = 100e6;
        _buyWithEth(Mainnet.USDC, 0.1 ether);
        (, uint24 fee) = _bestQuote(Mainnet.USDC, Mainnet.WBTC, amount);
        uint64 recoverAfter = uint64(block.timestamp + 1 hours);
        ExitSettlement settlement = ExitSettlement(
            payable(
                factory.create(
                    keccak256("stuck"),
                    recipient,
                    ExitSettlement.OutputAsset.WBTC,
                    type(uint256).max,
                    fee,
                    recoverAfter
                )
            )
        );
        usdc.transfer(address(settlement), amount);

        vm.expectRevert();
        settlement.settle();
        vm.expectRevert(ExitSettlement.RecoveryNotReady.selector);
        settlement.recoverAsUsdc();

        vm.warp(recoverAfter);
        vm.prank(relayer);
        settlement.recoverAsUsdc();

        require(usdc.balanceOf(recipient) == amount, "recipient did not recover USDC");
        require(usdc.balanceOf(address(settlement)) == 0, "USDC left in settlement");
        require(settlement.settled(), "not marked settled");
    }

    function testSettleRevertsWithoutUsdc() public {
        ExitSettlement settlement =
            _createSettlement(keccak256("empty"), ExitSettlement.OutputAsset.USDC, 1, 500);
        vm.expectRevert(ExitSettlement.EmptyBalance.selector);
        settlement.settle();
    }

    // ---------------------------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------------------------

    function _intent(
        bytes32 flowId,
        PrivacyEntryRouter.InputAsset inputAsset,
        uint256 amountIn,
        uint256 minimumUsdc,
        uint24 poolFee
    ) private view returns (PrivacyEntryRouter.EntryIntent memory) {
        return PrivacyEntryRouter.EntryIntent({
            flowId: flowId,
            inputAsset: inputAsset,
            amountIn: amountIn,
            minimumUsdc: minimumUsdc,
            poolFee: poolFee,
            starknetRecipient: STARKNET_RECIPIENT,
            cctpMaxFee: _fastTransferFee(minimumUsdc),
            minFinalityThreshold: FAST_FINALITY,
            deadline: block.timestamp + 15 minutes
        });
    }

    /// @dev One basis point, matching Circle's published fast-transfer minimum for domain 0 -> 25.
    /// The live suite (e2e/src/mainnet/circle-iris.test.ts) checks the published value itself.
    function _fastTransferFee(uint256 amount) private pure returns (uint256) {
        return (amount + 9_999) / 10_000;
    }

    function _createSettlement(
        bytes32 salt,
        ExitSettlement.OutputAsset outputAsset,
        uint256 minimumOutput,
        uint24 poolFee
    ) private returns (ExitSettlement) {
        uint64 recoverAfter = uint64(block.timestamp + 1 hours);
        address predicted =
            factory.predict(salt, recipient, outputAsset, minimumOutput, poolFee, recoverAfter);
        address created =
            factory.create(salt, recipient, outputAsset, minimumOutput, poolFee, recoverAfter);
        require(created == predicted, "predict must equal create");
        return ExitSettlement(payable(created));
    }

    /// @dev Uniswap's router wraps ETH itself when tokenIn is WETH9 and msg.value is supplied.
    function _buyWithEth(address tokenOut, uint256 ethIn) private returns (uint256 received) {
        (, uint24 fee) = _bestQuote(Mainnet.WETH, tokenOut, ethIn);
        uint256 before = IERC20(tokenOut).balanceOf(address(this));
        ISwapRouter(Mainnet.SWAP_ROUTER).exactInputSingle{ value: ethIn }(
            ISwapRouter.ExactInputSingleParams({
                tokenIn: Mainnet.WETH,
                tokenOut: tokenOut,
                fee: fee,
                recipient: address(this),
                deadline: block.timestamp,
                amountIn: ethIn,
                amountOutMinimum: 1,
                sqrtPriceLimitX96: 0
            })
        );
        received = IERC20(tokenOut).balanceOf(address(this)) - before;
    }

    function _bestQuote(address tokenIn, address tokenOut, uint256 amountIn)
        private
        returns (uint256 best, uint24 bestFee)
    {
        uint24[4] memory fees = [uint24(100), 500, 3_000, 10_000];
        for (uint256 index; index < fees.length; index++) {
            try IQuoter(Mainnet.QUOTER).quoteExactInputSingle(
                tokenIn, tokenOut, fees[index], amountIn, 0
            ) returns (uint256 amountOut) {
                if (amountOut > best) {
                    best = amountOut;
                    bestFee = fees[index];
                }
            } catch { }
        }
        require(best > 0, "no Uniswap V3 pool quoted");
    }

    function _holdings(address account) private view returns (Holdings memory) {
        return Holdings({
            eth: account.balance,
            usdc: usdc.balanceOf(account),
            weth: weth.balanceOf(account),
            wbtc: wbtc.balanceOf(account)
        });
    }

    /// @dev The router must be a pure pass-through: nothing it touched may remain behind.
    function _assertRouterHoldsNothing() private view {
        Holdings memory current = _holdings(address(entry));
        require(current.usdc == routerBaseline.usdc, "router kept USDC");
        require(current.weth == routerBaseline.weth, "router kept WETH");
        require(current.wbtc == routerBaseline.wbtc, "router kept WBTC");
        require(current.eth == routerBaseline.eth, "router kept ETH");
    }

    function _assertDepositForBurn(
        Vm.Log[] memory logs,
        PrivacyEntryRouter.EntryIntent memory intent,
        uint256 burned
    ) private view {
        Vm.Log memory log = _single(logs, Mainnet.TOKEN_MESSENGER_V2, DEPOSIT_FOR_BURN_TOPIC);
        require(address(uint160(uint256(log.topics[1]))) == Mainnet.USDC, "burn token");
        require(address(uint160(uint256(log.topics[2]))) == address(entry), "depositor");
        require(uint32(uint256(log.topics[3])) == FAST_FINALITY, "min finality");
        (
            uint256 amount,
            bytes32 mintRecipient,
            uint32 destinationDomain,
            bytes32 destinationTokenMessenger,
            bytes32 destinationCaller,
            uint256 maxFee,
            bytes memory hookData
        ) = abi.decode(log.data, (uint256, bytes32, uint32, bytes32, bytes32, uint256, bytes));
        require(amount == burned, "burn amount");
        require(mintRecipient == bytes32(intent.starknetRecipient), "mint recipient");
        require(destinationDomain == Mainnet.STARKNET_DOMAIN, "destination domain");
        require(
            destinationTokenMessenger == Mainnet.STARKNET_TOKEN_MESSENGER_MINTER_V2,
            "destination messenger"
        );
        require(destinationCaller == bytes32(0), "destination caller");
        require(maxFee == intent.cctpMaxFee, "max fee");
        require(hookData.length == 0, "entry must not carry hook data");
    }

    function _assertCctpMessage(
        Vm.Log[] memory logs,
        PrivacyEntryRouter.EntryIntent memory intent,
        uint256 burned
    ) private view {
        Vm.Log memory log = _single(logs, Mainnet.MESSAGE_TRANSMITTER_V2, MESSAGE_SENT_TOPIC);
        bytes memory message = abi.decode(log.data, (bytes));
        require(message.length == MESSAGE_LENGTH_WITHOUT_HOOK, "message length");
        // MessageV2 header
        require(_u32(message, 0) == 1, "message version");
        require(_u32(message, 4) == Mainnet.ETHEREUM_DOMAIN, "source domain");
        require(_u32(message, 8) == Mainnet.STARKNET_DOMAIN, "destination domain");
        require(
            _b32(message, 44) == bytes32(uint256(uint160(Mainnet.TOKEN_MESSENGER_V2))), "sender"
        );
        require(_b32(message, 76) == Mainnet.STARKNET_TOKEN_MESSENGER_MINTER_V2, "recipient");
        require(_b32(message, 108) == bytes32(0), "destination caller");
        require(_u32(message, 140) == FAST_FINALITY, "min finality threshold");
        require(_u32(message, 144) == 0, "finality executed must be unset at burn");
        // BurnMessageV2 body
        require(_u32(message, 148) == 1, "body version");
        require(_b32(message, 152) == bytes32(uint256(uint160(Mainnet.USDC))), "body burn token");
        require(_b32(message, 184) == bytes32(intent.starknetRecipient), "body mint recipient");
        require(uint256(_b32(message, 216)) == burned, "body amount");
        require(
            _b32(message, 248) == bytes32(uint256(uint160(address(entry)))), "body message sender"
        );
        require(uint256(_b32(message, 280)) == intent.cctpMaxFee, "body max fee");
        require(uint256(_b32(message, 312)) == 0, "body fee executed");
        require(uint256(_b32(message, 344)) == 0, "body expiration block");
    }

    function _single(Vm.Log[] memory logs, address emitter, bytes32 topic)
        private
        pure
        returns (Vm.Log memory found)
    {
        uint256 matches;
        for (uint256 index; index < logs.length; index++) {
            if (
                logs[index].emitter == emitter && logs[index].topics.length > 0
                    && logs[index].topics[0] == topic
            ) {
                found = logs[index];
                matches++;
            }
        }
        require(matches == 1, "expected exactly one matching log");
    }

    function _b32(bytes memory data, uint256 offset) private pure returns (bytes32 word) {
        require(offset + 32 <= data.length, "read past message");
        assembly {
            word := mload(add(add(data, 32), offset))
        }
    }

    function _u32(bytes memory data, uint256 offset) private pure returns (uint32) {
        require(offset + 4 <= data.length, "read past message");
        bytes32 word;
        assembly {
            word := mload(add(add(data, 32), offset))
        }
        return uint32(bytes4(word));
    }
}
