// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IdentityRegistry
/// @notice A minimal ERC-8004-style agent identity registry: an agent registers once and
///         gets a portable numeric id plus a metadata URI (an agent card / endpoint). Other
///         contracts (e.g. ReputationRegistry) can reference the id, and indexers can resolve
///         an address to its agent card. Standalone and permissionless.
contract IdentityRegistry {
    struct Agent {
        uint256 id;
        address owner;
        string metadataURI;
        uint64 registeredAt;
    }

    uint256 public nextId = 1;
    mapping(address agent => uint256 id) public idOf;
    mapping(uint256 id => Agent) public agents;

    event AgentRegistered(uint256 indexed id, address indexed owner, string metadataURI);
    event MetadataUpdated(uint256 indexed id, string metadataURI);

    error AlreadyRegistered();
    error NotRegistered();

    /// @notice Register the caller as an agent. `metadataURI` points to the agent card.
    function register(string calldata metadataURI) external returns (uint256 id) {
        if (idOf[msg.sender] != 0) revert AlreadyRegistered();
        id = nextId++;
        idOf[msg.sender] = id;
        agents[id] = Agent({id: id, owner: msg.sender, metadataURI: metadataURI, registeredAt: uint64(block.timestamp)});
        emit AgentRegistered(id, msg.sender, metadataURI);
    }

    function setMetadata(string calldata metadataURI) external {
        uint256 id = idOf[msg.sender];
        if (id == 0) revert NotRegistered();
        agents[id].metadataURI = metadataURI;
        emit MetadataUpdated(id, metadataURI);
    }

    function isRegistered(address agent) external view returns (bool) {
        return idOf[agent] != 0;
    }
}
