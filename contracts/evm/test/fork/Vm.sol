// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @dev Minimal subset of Foundry's cheatcode interface. The repository deliberately has no
/// forge-std submodule; keep this to the cheatcodes the fork suite actually uses.
interface Vm {
    struct Log {
        bytes32[] topics;
        bytes data;
        address emitter;
    }

    function envOr(string calldata name, string calldata defaultValue)
        external
        view
        returns (string memory);
    function envOr(string calldata name, uint256 defaultValue) external view returns (uint256);
    function skip(bool skipTest) external;
    function createSelectFork(string calldata urlOrAlias) external returns (uint256 forkId);
    function createSelectFork(string calldata urlOrAlias, uint256 blockNumber)
        external
        returns (uint256 forkId);
    function deal(address account, uint256 newBalance) external;
    function prank(address msgSender) external;
    function warp(uint256 newTimestamp) external;
    function recordLogs() external;
    function getRecordedLogs() external returns (Log[] memory logs);
    function expectRevert() external;
    function expectRevert(bytes4 revertData) external;
    function expectRevert(bytes calldata revertData) external;
    function label(address account, string calldata newLabel) external;
}
