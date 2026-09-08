// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import { IERC20, ISwapRouter, ITokenMessengerV2, IWETH } from "../src/Interfaces.sol";
import { PrivacyEntryRouter } from "../src/PrivacyEntryRouter.sol";
import { ExitSettlement } from "../src/ExitSettlement.sol";
import { ExitSettlementFactory } from "../src/ExitSettlementFactory.sol";

contract MockToken is IERC20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }
    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }
    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }
    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        if (msg.sender != from) allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract MockWeth is MockToken, IWETH {
    function deposit() external payable { balanceOf[msg.sender] += msg.value; }
    function withdraw(uint256 amount) external {
        balanceOf[msg.sender] -= amount;
        (bool ok,) = msg.sender.call{ value: amount }("");
        require(ok);
    }
    receive() external payable {}
}

contract MockSwapRouter is ISwapRouter {
    uint256 public rateNumerator = 2;
    function setRate(uint256 value) external { rateNumerator = value; }
    function exactInputSingle(ExactInputSingleParams calldata p) external payable returns (uint256 out) {
        IERC20(p.tokenIn).transferFrom(msg.sender, address(this), p.amountIn);
        out = p.amountIn * rateNumerator;
        require(out >= p.amountOutMinimum, "SLIPPAGE");
        MockToken(p.tokenOut).mint(p.recipient, out);
    }
}

contract MockMessenger is ITokenMessengerV2 {
    IERC20 public immutable usdc;
    uint256 public amount;
    bytes32 public recipient;
    uint32 public domain;
    constructor(IERC20 usdc_) { usdc = usdc_; }
    function depositForBurn(
        uint256 amount_,
        uint32 domain_,
        bytes32 recipient_,
        address,
        bytes32,
        uint256,
        uint32
    ) external {
        usdc.transferFrom(msg.sender, address(this), amount_);
        amount = amount_;
        recipient = recipient_;
        domain = domain_;
    }
    function depositForBurnWithHook(
        uint256 amount_,
        uint32 domain_,
        bytes32 recipient_,
        address,
        bytes32,
        uint256,
        uint32,
        bytes calldata
    ) external {
        usdc.transferFrom(msg.sender, address(this), amount_);
        amount = amount_;
        recipient = recipient_;
        domain = domain_;
    }
}

contract PrivacyRoundTripEvmTest {
    MockToken usdc = new MockToken();
    MockToken wbtc = new MockToken();
    MockWeth weth = new MockWeth();
    MockSwapRouter swap = new MockSwapRouter();
    MockMessenger messenger = new MockMessenger(usdc);
    PrivacyEntryRouter entry = new PrivacyEntryRouter(
        address(usdc), address(wbtc), address(weth), address(swap), address(messenger)
    );

    function testUsdcEntryBurnsToStarknet() public {
        usdc.mint(address(this), 10_000_000);
        usdc.approve(address(entry), 10_000_000);
        PrivacyEntryRouter.EntryIntent memory intent = PrivacyEntryRouter.EntryIntent({
            flowId: keccak256("usdc"),
            inputAsset: PrivacyEntryRouter.InputAsset.USDC,
            amountIn: 10_000_000,
            minimumUsdc: 9_000_000,
            poolFee: 0,
            starknetRecipient: 0x123,
            cctpMaxFee: 100_000,
            minFinalityThreshold: 1_000,
            deadline: block.timestamp
        });
        uint256 burned = entry.start(intent);
        require(burned == 10_000_000);
        require(messenger.amount() == 10_000_000);
        require(messenger.domain() == 25);
        require(messenger.recipient() == bytes32(uint256(0x123)));
    }

    function testWbtcEntrySwapsBeforeBurn() public {
        wbtc.mint(address(this), 1_000);
        wbtc.approve(address(entry), 1_000);
        PrivacyEntryRouter.EntryIntent memory intent = PrivacyEntryRouter.EntryIntent({
            flowId: keccak256("wbtc"),
            inputAsset: PrivacyEntryRouter.InputAsset.WBTC,
            amountIn: 1_000,
            minimumUsdc: 1_900,
            poolFee: 3_000,
            starknetRecipient: 0x456,
            cctpMaxFee: 100,
            minFinalityThreshold: 1_000,
            deadline: block.timestamp
        });
        require(entry.start(intent) == 2_000);
        require(messenger.amount() == 2_000);
    }

    function testSettlementPaysFixedRecipient() public {
        ExitSettlementFactory factory = new ExitSettlementFactory(
            address(usdc), address(wbtc), address(weth), address(swap)
        );
        address recipient = address(0xBEEF);
        address settlement = factory.create(
            keccak256("exit"),
            payable(recipient),
            ExitSettlement.OutputAsset.WBTC,
            1_900,
            3_000,
            uint64(block.timestamp + 1 days)
        );
        usdc.mint(settlement, 1_000);
        require(ExitSettlement(payable(settlement)).settle() == 2_000);
        require(wbtc.balanceOf(recipient) == 2_000);
    }
}

interface Vm {
    function expectRevert(bytes4) external;
    function expectRevert(bytes calldata) external;
    function prank(address) external;
    function warp(uint256) external;
    function deal(address, uint256) external;
}

contract ExitSettlementSafetyTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    MockToken usdc = new MockToken();
    MockToken wbtc = new MockToken();
    MockWeth weth = new MockWeth();
    MockSwapRouter swap = new MockSwapRouter();
    ExitSettlementFactory factory = new ExitSettlementFactory(address(usdc), address(wbtc), address(weth), address(swap));
    address recipient = address(0xBEEF);
    address griefer = address(0xBAD);

    function testPredictMatchesCreate() public {
        bytes32 salt = keccak256("predict");
        uint64 recoverAfter = uint64(block.timestamp + 1 hours);
        address predicted = factory.predict(salt, payable(recipient), ExitSettlement.OutputAsset.ETH, 123, 500, recoverAfter);
        address created = factory.create(salt, payable(recipient), ExitSettlement.OutputAsset.ETH, 123, 500, recoverAfter);
        require(predicted == created, "predict != create");
    }

    /// A dust deposit plus an early settle() must not lock the real CCTP mint that lands afterwards.
    function testDustSettleDoesNotLockLaterMint() public {
        address settlement = factory.create(
            keccak256("usdc-out"), payable(recipient), ExitSettlement.OutputAsset.USDC, 0, 0, uint64(block.timestamp + 1 hours)
        );
        usdc.mint(settlement, 1);
        vm.prank(griefer);
        ExitSettlement(payable(settlement)).settle();
        require(usdc.balanceOf(recipient) == 1, "dust forwarded");

        usdc.mint(settlement, 10_000_000_000);
        ExitSettlement(payable(settlement)).settle();
        require(usdc.balanceOf(recipient) == 10_000_000_001, "real mint paid out");
        require(usdc.balanceOf(settlement) == 0, "nothing stranded");
    }

    /// Same for the recovery path on a swap-output settlement.
    function testDustRecoveryDoesNotLockLaterMint() public {
        address settlement = factory.create(
            keccak256("wbtc-out"), payable(recipient), ExitSettlement.OutputAsset.WBTC, 1_900, 3_000, uint64(block.timestamp + 1 hours)
        );
        usdc.mint(settlement, 1);
        vm.expectRevert("SLIPPAGE");
        ExitSettlement(payable(settlement)).settle();

        vm.warp(block.timestamp + 1 hours);
        vm.prank(griefer);
        ExitSettlement(payable(settlement)).recoverAsUsdc();
        require(usdc.balanceOf(recipient) == 1, "dust recovered");

        usdc.mint(settlement, 1_000);
        require(ExitSettlement(payable(settlement)).settle() == 2_000, "swap still works");
        require(wbtc.balanceOf(recipient) == 2_000, "wbtc paid out");
    }

    function testEmptySettleReverts() public {
        address settlement = factory.create(
            keccak256("empty"), payable(recipient), ExitSettlement.OutputAsset.USDC, 0, 0, uint64(block.timestamp + 1 hours)
        );
        vm.expectRevert(ExitSettlement.EmptyBalance.selector);
        ExitSettlement(payable(settlement)).settle();
    }

    function testRecoveryWaitsForWindow() public {
        address settlement = factory.create(
            keccak256("window"), payable(recipient), ExitSettlement.OutputAsset.WBTC, 1, 3_000, uint64(block.timestamp + 1 hours)
        );
        usdc.mint(settlement, 5);
        vm.expectRevert(ExitSettlement.RecoveryNotReady.selector);
        ExitSettlement(payable(settlement)).recoverAsUsdc();
    }

    function testSwapOutputRequiresFloor() public {
        vm.expectRevert(ExitSettlement.BadConfiguration.selector);
        factory.create(
            keccak256("no-floor"), payable(recipient), ExitSettlement.OutputAsset.WBTC, 0, 3_000, uint64(block.timestamp + 1 hours)
        );
        // USDC output has no swap, so no floor is required.
        factory.create(
            keccak256("usdc-no-floor"), payable(recipient), ExitSettlement.OutputAsset.USDC, 0, 0, uint64(block.timestamp + 1 hours)
        );
    }

    function testEthOutputPaysRecipient() public {
        address settlement = factory.create(
            keccak256("eth-out"), payable(recipient), ExitSettlement.OutputAsset.ETH, 1_900, 500, uint64(block.timestamp + 1 hours)
        );
        usdc.mint(settlement, 1_000);
        vm.deal(address(weth), 1 ether);
        uint256 before = recipient.balance;
        require(ExitSettlement(payable(settlement)).settle() == 2_000, "eth output");
        require(recipient.balance - before == 2_000, "eth paid");
    }
}
