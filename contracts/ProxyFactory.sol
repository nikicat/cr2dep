// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title ProxyFactory
/// @notice Deploys tiny EIP-1167-style delegation proxies via CREATE2. The 32-byte
/// `commitment` is appended to the init code (but not copied to runtime), so the
/// CREATE2 address is uniquely bound to (factory, salt, implementation, commitment)
/// while the deployed runtime stays at a canonical 45-byte EIP-1167 stub.
///
/// Init code layout (87 bytes):
///   [0x00..0x0a)  constructor: copies the next 45 bytes to memory and returns them
///   [0x0a..0x37)  EIP-1167 minimal proxy stub delegating to `implementation`
///   [0x37..0x57)  the commitment — affects the init-code hash (→ CREATE2 address)
///                 but is never deployed as runtime
///
/// PREFIX is the CREATE2 prefix byte used by the host VM:
///   0x41 for TRON, 0xff for standard EVM (Ethereum, EDR for tests).
/// It only affects the `computeAddress` view function; the on-chain `deploy`
/// uses the VM's native CREATE2 opcode regardless.
contract ProxyFactory {
    bytes1 public immutable PREFIX;

    event Deployed(
        address indexed proxy,
        address indexed implementation,
        bytes32 indexed commitment,
        bytes32 salt
    );

    error DeployFailed();

    constructor(bytes1 prefix_) {
        PREFIX = prefix_;
    }

    function deploy(address implementation, bytes32 salt, bytes32 commitment)
        external
        returns (address proxy)
    {
        bytes memory init = _initCode(implementation, commitment);
        assembly {
            proxy := create2(0, add(init, 0x20), mload(init), salt)
        }
        if (proxy == address(0)) revert DeployFailed();
        emit Deployed(proxy, implementation, commitment, salt);
    }

    /// @notice CREATE2 address derivation: keccak256(PREFIX ‖ factory ‖ salt ‖ keccak256(initCode))[12:]
    function computeAddress(address implementation, bytes32 salt, bytes32 commitment)
        external
        view
        returns (address)
    {
        bytes32 codeHash = keccak256(_initCode(implementation, commitment));
        return address(uint160(uint256(keccak256(
            abi.encodePacked(PREFIX, address(this), salt, codeHash)
        ))));
    }

    function _initCode(address implementation, bytes32 commitment)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodePacked(
            hex"3d602d80600a3d3981f3", // constructor: return 45 bytes from offset 10
            hex"363d3d373d3d3d363d73",
            implementation,
            hex"5af43d82803e903d91602b57fd5bf3",
            commitment
        );
    }
}
