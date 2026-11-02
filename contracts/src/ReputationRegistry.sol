// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ReputationRegistry
/// @notice Settlement-backed reputation for agent commerce (ERC-8004-style). Only the
///         A2ASettlement contract that deployed this registry may write to it, and it writes
///         exactly one record per settled deal — a released delivery or a timeout refund.
///
/// Because the sole writer is the escrow that actually moved the funds, this reputation
/// cannot be fabricated by self-reported claims: every entry corresponds to a real on-chain
/// release or refund. Self-dealing (payer == provider) is excluded by the caller. Scores are
/// readable on-chain and emitted as events for indexers.
contract ReputationRegistry {
    enum Outcome {
        Released,
        Refunded
    }

    struct Score {
        uint256 released;
        uint256 refunded;
        uint256 volumeReleased;
        uint256 volumeRefunded;
        uint64 lastUpdate;
    }

    /// @notice The authorized writer — the A2ASettlement that deployed this registry.
    address public immutable settlement;

    mapping(address provider => Score) private _scores;

    event SettlementRecorded(
        address indexed provider,
        address indexed payer,
        bytes32 indexed serviceId,
        uint256 amount,
        Outcome outcome,
        bytes32 deliveryHash
    );

    error NotSettlement();

    constructor(address settlement_) {
        settlement = settlement_;
    }

    function record(
        address provider,
        address payer,
        bytes32 serviceId,
        uint256 amount,
        Outcome outcome,
        bytes32 deliveryHash
    ) external {
        if (msg.sender != settlement) revert NotSettlement();
        Score storage s = _scores[provider];
        if (outcome == Outcome.Released) {
            s.released += 1;
            s.volumeReleased += amount;
        } else {
            s.refunded += 1;
            s.volumeRefunded += amount;
        }
        s.lastUpdate = uint64(block.timestamp);
        emit SettlementRecorded(provider, payer, serviceId, amount, outcome, deliveryHash);
    }

    function scoreOf(address provider) external view returns (Score memory) {
        return _scores[provider];
    }

    /// @notice Delivery success rate in basis points (0 if no settled deals yet).
    function successRateBps(address provider) external view returns (uint256) {
        Score storage s = _scores[provider];
        uint256 total = s.released + s.refunded;
        if (total == 0) return 0;
        return (s.released * 10_000) / total;
    }
}
