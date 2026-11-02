// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title EIP-3009: Transfer With Authorization
/// @notice Gasless, signature-authorized transfers (the scheme x402 and HSP's `eip3009`
///         protocol use). A third party submits the payer's signed authorization.
interface IERC3009 {
    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;

    /// @dev Like transferWithAuthorization, but requires msg.sender == to, which stops a
    ///      front-runner from redirecting the authorization.
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;

    function authorizationState(address authorizer, bytes32 nonce) external view returns (bool);
}
