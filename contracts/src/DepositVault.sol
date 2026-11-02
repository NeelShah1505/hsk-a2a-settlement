// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title DepositVault
/// @notice A minimal, per-deal holding address. One implementation is deployed by
///         A2ASettlement; every deal gets its own EIP-1167 clone at a deterministic
///         address derived from the deal terms (see A2ASettlement.depositAddress).
///
/// The address exists counterfactually before any code is deployed, so a payer — or
/// HashKey's HSP relayer calling `transferWithAuthorization` into the order's `pay_to` —
/// can send the settlement token to it before the clone exists. A2ASettlement later
/// deploys the clone and calls `pull` to move the funds into escrow or back to the payer.
///
/// `settlement` is an immutable set to the deployer (A2ASettlement) in the implementation
/// constructor. Because clones delegatecall into the implementation runtime code, every
/// clone reads the same immutable, so only A2ASettlement can ever call `pull`.
contract DepositVault {
    using SafeERC20 for IERC20;

    address public immutable settlement;

    error NotSettlement();

    constructor() {
        settlement = msg.sender;
    }

    /// @notice Move `amount` of `token` held by this vault to `to`. A2ASettlement only.
    function pull(IERC20 token, address to, uint256 amount) external {
        if (msg.sender != settlement) revert NotSettlement();
        token.safeTransfer(to, amount);
    }
}
