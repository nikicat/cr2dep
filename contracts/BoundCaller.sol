// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title BoundCaller
/// @notice Logic contract behind every ProxyFactory proxy. The proxy delegate-calls
/// into here; this contract verifies the proxy's *own address* commits to the
/// supplied (target, data) before forwarding the call.
///
/// Invariant: a proxy at address A can only ever forward to the (target, data) pair
/// whose CREATE2 derivation produced A. Anyone may invoke `execute` — the address
/// binding, not access control, is what makes each proxy single-purpose.
///
/// Verification: re-derive the CREATE2 address from (FACTORY, salt, keccak256(initCode))
/// where initCode embeds SELF and `commitment = keccak256(abi.encode(target, data))`,
/// and require it equals `address(this)` (the proxy in delegatecall context).
///
/// PREFIX is the CREATE2 prefix byte (0x41 for TRON, 0xff for standard EVM). Must
/// match the PREFIX of the deploying factory — otherwise every binding check fails.
contract BoundCaller {
    /// @notice This contract's own address (set at construction, inlined via immutable
    /// so it stays correct under delegatecall — `address(this)` would be the proxy).
    address public immutable SELF;
    /// @notice The factory that's permitted to mint proxies referencing this impl.
    address public immutable FACTORY;
    /// @notice CREATE2 prefix byte. Must match the factory's PREFIX.
    bytes1 public immutable PREFIX;

    event Executed(bytes32 indexed commitment, bytes32 salt, address indexed target);

    error BindingMismatch();
    error CallReverted(bytes returnData);

    constructor(address factory_, bytes1 prefix_) {
        SELF = address(this);
        FACTORY = factory_;
        PREFIX = prefix_;
    }

    /// @notice Triggers `target.call{value: msg.value}(data)` from the proxy, provided
    /// that the proxy's address matches the CREATE2 derivation for (salt, target, data).
    function execute(bytes32 salt, address target, bytes calldata data)
        external
        payable
        returns (bytes memory)
    {
        bytes32 commitment = keccak256(abi.encode(target, data));
        if (_proxyAddress(salt, commitment) != address(this)) revert BindingMismatch();

        (bool ok, bytes memory ret) = target.call{value: msg.value}(data);
        if (!ok) revert CallReverted(ret);

        emit Executed(commitment, salt, target);
        return ret;
    }

    /// @notice Off-chain-mirrorable view: predicted proxy address for a (salt, commitment).
    function proxyAddressFor(bytes32 salt, bytes32 commitment) external view returns (address) {
        return _proxyAddress(salt, commitment);
    }

    function _proxyAddress(bytes32 salt, bytes32 commitment) internal view returns (address) {
        bytes32 codeHash = keccak256(abi.encodePacked(
            hex"3d602d80600a3d3981f3",
            hex"363d3d373d3d3d363d73", SELF, hex"5af43d82803e903d91602b57fd5bf3",
            commitment
        ));
        return address(uint160(uint256(keccak256(
            abi.encodePacked(PREFIX, FACTORY, salt, codeHash)
        ))));
    }
}
