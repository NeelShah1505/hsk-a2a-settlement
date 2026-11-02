// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC3009} from "./interfaces/IERC3009.sol";

/// @title A2ASettlement
/// @notice Trust-minimized agent-to-agent commerce on HSK Chain.
///
/// x402-style "pay, then deliver" gives the paying agent no guarantee that it will ever
/// receive what it paid for. This contract adds escrow with a delivery receipt:
///
///   1. A receiving agent (provider) registers a service: price, settlement token,
///      payout address and a delivery window.
///   2. The paying agent signs a gasless EIP-3009 authorization. Anyone (usually the
///      provider) relays it; the exact price moves into escrow. The authorization nonce is
///      bound to (contract, chain, requestId, serviceId), so a signature cannot be replayed
///      for another request or service.
///   3. The provider checks the escrow on-chain, delivers the resource off-chain, then calls
///      confirmDelivery with a hash of what it delivered. Funds are released to payTo.
///   4. If the provider does not deliver before the deadline, anyone can trigger a refund
///      to the payer.
///
/// Payments made through another rail (for example the HSP Gateway) can be anchored here
/// as an on-chain receipt with anchorExternalSettlement.
contract A2ASettlement is ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum Status {
        None,
        Escrowed,
        Released,
        Refunded
    }

    struct Service {
        address provider; // receiving agent: manages the service and confirms delivery
        address payTo; // where released funds go
        address token; // settlement token (EIP-3009 for the gasless path)
        uint256 price; // exact amount, in token units
        uint64 deliveryWindow; // seconds the provider has to deliver after escrow
        bool active;
    }

    struct Payment {
        bytes32 serviceId;
        address payer;
        address payTo; // snapshot at escrow time
        address token; // snapshot at escrow time
        uint256 amount;
        uint64 escrowedAt;
        uint64 deadline;
        Status status;
        bytes32 deliveryHash;
    }

    uint64 public constant MIN_DELIVERY_WINDOW = 60;
    uint64 public constant MAX_DELIVERY_WINDOW = 30 days;

    mapping(bytes32 serviceId => Service) public services;
    /// @dev Keyed by paymentKey(payer, requestId) so nobody can squat another payer's requestId.
    mapping(bytes32 key => Payment) private _payments;
    mapping(bytes32 key => bool) public anchored;

    event ServiceRegistered(
        bytes32 indexed serviceId,
        address indexed provider,
        address payTo,
        address token,
        uint256 price,
        uint64 deliveryWindow
    );
    event ServiceStatusChanged(bytes32 indexed serviceId, bool active);
    event PaymentEscrowed(
        bytes32 indexed requestId,
        bytes32 indexed serviceId,
        address indexed payer,
        address token,
        uint256 amount,
        uint64 deadline,
        bool gasless
    );
    event PaymentReleased(
        bytes32 indexed requestId, address indexed payer, address payTo, uint256 amount, bytes32 deliveryHash
    );
    event PaymentRefunded(bytes32 indexed requestId, address indexed payer, uint256 amount);
    event ExternalSettlementAnchored(
        bytes32 indexed requestId,
        bytes32 indexed serviceId,
        address indexed payer,
        uint256 amount,
        string rail,
        string externalRef,
        bytes32 deliveryHash
    );

    error NotProvider();
    error InvalidService();
    error ServiceInactive();
    error ZeroAddress();
    error InvalidPrice();
    error InvalidDeliveryWindow();
    error PaymentExists();
    error PaymentNotEscrowed();
    error DeliveryWindowClosed();
    error DeliveryWindowOpen();
    error InvalidDeliveryHash();
    error AmountMismatch();
    error AlreadyAnchored();

    // ─────────────────────────────── services ───────────────────────────────

    /// @notice Register a new service, or update one you already provide.
    function registerService(bytes32 serviceId, address payTo, address token, uint256 price, uint64 deliveryWindow)
        external
    {
        Service storage svc = services[serviceId];
        if (svc.provider != address(0) && svc.provider != msg.sender) revert NotProvider();
        if (payTo == address(0) || token == address(0)) revert ZeroAddress();
        if (price == 0) revert InvalidPrice();
        if (deliveryWindow < MIN_DELIVERY_WINDOW || deliveryWindow > MAX_DELIVERY_WINDOW) {
            revert InvalidDeliveryWindow();
        }

        svc.provider = msg.sender;
        svc.payTo = payTo;
        svc.token = token;
        svc.price = price;
        svc.deliveryWindow = deliveryWindow;
        svc.active = true;

        emit ServiceRegistered(serviceId, msg.sender, payTo, token, price, deliveryWindow);
    }

    function setServiceActive(bytes32 serviceId, bool active) external {
        Service storage svc = services[serviceId];
        if (svc.provider == address(0)) revert InvalidService();
        if (svc.provider != msg.sender) revert NotProvider();
        svc.active = active;
        emit ServiceStatusChanged(serviceId, active);
    }

    // ─────────────────────────────── views ───────────────────────────────

    /// @notice Storage key for a payment. Scoped to the payer so request ids cannot be squatted.
    function paymentKey(address payer, bytes32 requestId) public pure returns (bytes32) {
        return keccak256(abi.encode(payer, requestId));
    }

    /// @notice The EIP-3009 nonce the payer must sign. Binds the authorization to this
    ///         contract, this chain, this request and this service.
    function authorizationNonce(bytes32 requestId, bytes32 serviceId) public view returns (bytes32) {
        return keccak256(abi.encode(address(this), block.chainid, requestId, serviceId));
    }

    function getPayment(address payer, bytes32 requestId) external view returns (Payment memory) {
        return _payments[paymentKey(payer, requestId)];
    }

    // ─────────────────────────────── settlement ───────────────────────────────

    /// @notice Escrow a payment using the payer's signed EIP-3009 ReceiveWithAuthorization.
    ///         The payer needs no gas; whoever relays pays it.
    function settleWithAuthorization(
        bytes32 requestId,
        bytes32 serviceId,
        address payer,
        uint256 validAfter,
        uint256 validBefore,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant {
        (Service storage svc, bytes32 key) = _openPayment(requestId, serviceId, payer);

        IERC20 token = IERC20(svc.token);
        uint256 before = token.balanceOf(address(this));
        IERC3009(svc.token).receiveWithAuthorization(
            payer,
            address(this),
            svc.price,
            validAfter,
            validBefore,
            authorizationNonce(requestId, serviceId),
            v,
            r,
            s
        );
        if (token.balanceOf(address(this)) - before != svc.price) revert AmountMismatch();

        _emitEscrowed(requestId, key, true);
    }

    /// @notice Escrow a payment from msg.sender using a prior ERC-20 approval. Universal
    ///         fallback for tokens without EIP-3009; the payer pays gas.
    function settle(bytes32 requestId, bytes32 serviceId) external nonReentrant {
        (Service storage svc, bytes32 key) = _openPayment(requestId, serviceId, msg.sender);

        IERC20 token = IERC20(svc.token);
        uint256 before = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), svc.price);
        if (token.balanceOf(address(this)) - before != svc.price) revert AmountMismatch();

        _emitEscrowed(requestId, key, false);
    }

    /// @notice Provider confirms delivery with a hash of the delivered resource; releases funds.
    function confirmDelivery(address payer, bytes32 requestId, bytes32 deliveryHash) external nonReentrant {
        bytes32 key = paymentKey(payer, requestId);
        Payment storage p = _payments[key];
        if (p.status != Status.Escrowed) revert PaymentNotEscrowed();
        if (services[p.serviceId].provider != msg.sender) revert NotProvider();
        if (deliveryHash == bytes32(0)) revert InvalidDeliveryHash();
        if (block.timestamp > p.deadline) revert DeliveryWindowClosed();

        p.status = Status.Released;
        p.deliveryHash = deliveryHash;
        IERC20(p.token).safeTransfer(p.payTo, p.amount);

        emit PaymentReleased(requestId, payer, p.payTo, p.amount, deliveryHash);
    }

    /// @notice Refund the payer if the provider missed the delivery deadline. Callable by anyone.
    function refund(address payer, bytes32 requestId) external nonReentrant {
        bytes32 key = paymentKey(payer, requestId);
        Payment storage p = _payments[key];
        if (p.status != Status.Escrowed) revert PaymentNotEscrowed();
        if (block.timestamp <= p.deadline) revert DeliveryWindowOpen();

        p.status = Status.Refunded;
        IERC20(p.token).safeTransfer(payer, p.amount);

        emit PaymentRefunded(requestId, payer, p.amount);
    }

    /// @notice Anchor a payment settled through another rail (e.g. the HSP Gateway) as an
    ///         on-chain receipt. Only the service provider can attest for its own service.
    function anchorExternalSettlement(
        bytes32 requestId,
        bytes32 serviceId,
        address payer,
        uint256 amount,
        string calldata rail,
        string calldata externalRef,
        bytes32 deliveryHash
    ) external {
        Service storage svc = services[serviceId];
        if (svc.provider == address(0)) revert InvalidService();
        if (svc.provider != msg.sender) revert NotProvider();
        if (payer == address(0)) revert ZeroAddress();

        bytes32 key = paymentKey(payer, requestId);
        if (anchored[key]) revert AlreadyAnchored();
        anchored[key] = true;

        emit ExternalSettlementAnchored(requestId, serviceId, payer, amount, rail, externalRef, deliveryHash);
    }

    // ─────────────────────────────── internals ───────────────────────────────

    function _openPayment(bytes32 requestId, bytes32 serviceId, address payer)
        private
        returns (Service storage svc, bytes32 key)
    {
        svc = services[serviceId];
        if (svc.provider == address(0)) revert InvalidService();
        if (!svc.active) revert ServiceInactive();
        if (payer == address(0)) revert ZeroAddress();

        key = paymentKey(payer, requestId);
        Payment storage p = _payments[key];
        if (p.status != Status.None) revert PaymentExists();

        // Effects before the token interaction (checks-effects-interactions).
        uint64 nowTs = uint64(block.timestamp);
        p.serviceId = serviceId;
        p.payer = payer;
        p.payTo = svc.payTo;
        p.token = svc.token;
        p.amount = svc.price;
        p.escrowedAt = nowTs;
        p.deadline = nowTs + svc.deliveryWindow;
        p.status = Status.Escrowed;
    }

    function _emitEscrowed(bytes32 requestId, bytes32 key, bool gasless) private {
        Payment storage p = _payments[key];
        emit PaymentEscrowed(requestId, p.serviceId, p.payer, p.token, p.amount, p.deadline, gasless);
    }
}
