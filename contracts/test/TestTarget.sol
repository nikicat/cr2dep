// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Minimal stateful target used by `cr2dep.test.ts` to verify that
/// `BoundCaller.execute` actually forwards calldata and value.
contract TestTarget {
    uint256 public count;
    address public lastCaller;
    uint256 public lastValue;

    error Boom(string why);

    function bump(uint256 by) external payable {
        count += by;
        lastCaller = msg.sender;
        lastValue = msg.value;
    }

    function boom(string calldata why) external pure {
        revert Boom(why);
    }
}
