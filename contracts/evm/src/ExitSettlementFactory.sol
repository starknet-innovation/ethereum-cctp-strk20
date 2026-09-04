// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import { ExitSettlement } from "./ExitSettlement.sol";

/// @notice Permissionless factory used by the gas-sponsored backend immediately before pool exit.
contract ExitSettlementFactory {
    error DuplicateSalt(bytes32 salt);

    event SettlementCreated(bytes32 indexed salt, address indexed settlement);

    address public immutable usdc;
    address public immutable wbtc;
    address public immutable weth;
    address public immutable swapRouter;
    mapping(bytes32 salt => address settlement) public settlements;

    constructor(address usdc_, address wbtc_, address weth_, address swapRouter_) {
        usdc = usdc_;
        wbtc = wbtc_;
        weth = weth_;
        swapRouter = swapRouter_;
    }

    function create(
        bytes32 salt,
        address payable recipient,
        ExitSettlement.OutputAsset outputAsset,
        uint256 minimumOutput,
        uint24 poolFee,
        uint64 recoverAfter
    ) external returns (address settlement) {
        if (settlements[salt] != address(0)) revert DuplicateSalt(salt);
        settlement = address(
            new ExitSettlement{ salt: salt }(
                usdc,
                wbtc,
                weth,
                swapRouter,
                recipient,
                outputAsset,
                minimumOutput,
                poolFee,
                recoverAfter
            )
        );
        settlements[salt] = settlement;
        emit SettlementCreated(salt, settlement);
    }

    function predict(
        bytes32 salt,
        address payable recipient,
        ExitSettlement.OutputAsset outputAsset,
        uint256 minimumOutput,
        uint24 poolFee,
        uint64 recoverAfter
    ) external view returns (address) {
        bytes memory initCode = abi.encodePacked(
            type(ExitSettlement).creationCode,
            abi.encode(
                usdc,
                wbtc,
                weth,
                swapRouter,
                recipient,
                outputAsset,
                minimumOutput,
                poolFee,
                recoverAfter
            )
        );
        bytes32 digest = keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, keccak256(initCode)));
        return address(uint160(uint256(digest)));
    }
}
