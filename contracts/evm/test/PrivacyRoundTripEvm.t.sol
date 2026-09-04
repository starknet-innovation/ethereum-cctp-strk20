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
