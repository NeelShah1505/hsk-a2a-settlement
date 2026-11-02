// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IERC3009} from "./interfaces/IERC3009.sol";
import {DepositVault} from "./DepositVault.sol";

/// @title A2ASettlement
/// @notice Trust-minimized agent-to-agent commerce on HSK Chain.
///
/// A receiving agent (provider) registers a service: price, settlement token, payout
/// address and a delivery window. A paying agent gets the funds into escrow by one of:
///
///   1. EIP-3009 (gasless): the payer signs a ReceiveWithAuthorization to this contract
///      with a nonce bound to (contract, chain, requestId, serviceId); anyone relays it.
///   2. ERC-20 approval: the payer approves and calls settle() itself.
///   3. Deposit vault: the payer (or HashKey's HSP relayer settling into the order's
///      pay_to) sends the token to a deterministic per-deal address whose salt commits to
///      the exact terms; anyone registered claims it into escrow via claimDeposit().
///
/// Once escrowed, the provider calls confirmDelivery with a hash of the delivered resource
/// to release funds, or anyone can refund the payer after the delivery deadline. Payments
/// settled on another rail (e.g. the HSP Gateway) can be anchored here as a receipt.
///
/// Payments are keyed by (payer, requestId, serviceId) so no party can squat another
/// deal's slot. This contract never grants an admin the ability to move escrowed funds.
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
        address token; // settlement token (EIP-3009 for the gasless/deposit paths)
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

    /// @notice Deal terms that a deposit address commits to. The payer recomputes the
    ///         address from these locally and refuses to pay unless it matches the order's
    ///         pay_to, so the provider cannot change price/token/window after a deposit.
    struct DepositTerms {
        address payer;
        bytes32 requestId;
        bytes32 serviceId;
        address token;
        uint256 price;
        uint64 deliveryWindow;
        uint64 claimBy; // deposits must be claimed by this timestamp
    }

    struct ProviderActivity {
        uint256 released;
        uint256 refunded;
        uint256 volumeReleased;
        uint256 volumeRefunded;
    }

    uint64 public constant MIN_DELIVERY_WINDOW = 60;
    uint64 public constant MAX_DELIVERY_WINDOW = 30 days;

    /// @notice The DepositVault implementation that every per-deal clone delegatecalls into.
    ///         Deposits must never be sent here; it is not a deposit address.
    address public immutable depositVaultImplementation;

    mapping(bytes32 serviceId => Service) public services;
    mapping(bytes32 key => Payment) private _payments;
    mapping(bytes32 key => bool) public anchored;
    /// @notice Self-reportable activity counters, NOT a trust score. A provider can inflate
    ///         released/volumeReleased by paying itself; self-dealing (payer == provider or
    ///         payer == payTo) is excluded from the counters, which stops only the lazy case.
    mapping(address provider => ProviderActivity) public providerActivity;

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
        uint8 rail // 0 = eip3009, 1 = approval, 2 = deposit-vault
    );
    event PaymentReleased(
        bytes32 indexed requestId, bytes32 indexed serviceId, address indexed payer, address payTo, uint256 amount, bytes32 deliveryHash
    );
    event PaymentRefunded(bytes32 indexed requestId, bytes32 indexed serviceId, address indexed payer, uint256 amount);
    event DepositVaultDeployed(address indexed vault, address indexed payer, bytes32 indexed requestId, bytes32 serviceId);
    event DepositClaimed(
        bytes32 indexed requestId, bytes32 indexed serviceId, address indexed payer, address vault, uint256 amount, bytes32 termsHash
    );
    event ExcessDepositRefunded(
        bytes32 indexed requestId, bytes32 indexed serviceId, address indexed payer, address token, uint256 amount
    );
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
    error TermsMismatch();
    error ClaimWindowClosed();
    error NotAuthorized();
    error InsufficientDeposit(uint256 balance, uint256 required);
    error NothingToRefund();

    constructor() {
        depositVaultImplementation = address(new DepositVault());
    }

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

    /// @notice Storage key for a payment, scoped to payer + request + service.
    function paymentKey(address payer, bytes32 requestId, bytes32 serviceId) public pure returns (bytes32) {
        return keccak256(abi.encode(payer, requestId, serviceId));
    }

    /// @notice The EIP-3009 nonce the payer must sign for the gasless rail. Binds the
    ///         authorization to this contract, this chain, this request and this service.
    function authorizationNonce(bytes32 requestId, bytes32 serviceId) public view returns (bytes32) {
        return keccak256(abi.encode(address(this), block.chainid, requestId, serviceId));
    }

    function getPayment(address payer, bytes32 requestId, bytes32 serviceId) external view returns (Payment memory) {
        return _payments[paymentKey(payer, requestId, serviceId)];
    }

    function depositSalt(DepositTerms calldata t) public pure returns (bytes32) {
        return keccak256(abi.encode(t));
    }

    /// @notice The deterministic deposit address for a set of terms. Use this as the HSP
    ///         order's pay_to (or a plain transfer target). The payer MUST verify this
    ///         equals pay_to before paying.
    function depositAddress(DepositTerms calldata t) public view returns (address) {
        return Clones.predictDeterministicAddress(depositVaultImplementation, depositSalt(t), address(this));
    }

    /// @notice Convenience view for clients: the vault, its balance of the terms token,
    ///         whether a clone is deployed, whether a claim would succeed now, and the
    ///         payment status for these terms.
    function depositStatus(DepositTerms calldata t)
        external
        view
        returns (address vault, uint256 balance, bool deployed, bool claimable, Status paymentStatus)
    {
        vault = depositAddress(t);
        balance = IERC20(t.token).balanceOf(vault);
        deployed = vault.code.length > 0;
        paymentStatus = _payments[paymentKey(t.payer, t.requestId, t.serviceId)].status;
        Service storage svc = services[t.serviceId];
        claimable = paymentStatus == Status.None && svc.active && block.timestamp <= t.claimBy && balance >= t.price
            && svc.token == t.token && svc.price == t.price && svc.deliveryWindow == t.deliveryWindow;
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

        _emitEscrowed(requestId, key, 0);
    }

    /// @notice Escrow a payment from msg.sender using a prior ERC-20 approval.
    function settle(bytes32 requestId, bytes32 serviceId) external nonReentrant {
        (Service storage svc, bytes32 key) = _openPayment(requestId, serviceId, msg.sender);

        IERC20 token = IERC20(svc.token);
        uint256 before = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), svc.price);
        if (token.balanceOf(address(this)) - before != svc.price) revert AmountMismatch();

        _emitEscrowed(requestId, key, 1);
    }

    /// @notice Claim a terms-committed deposit into escrow. The deposit address encodes the
    ///         exact terms, so the price/token/window cannot have changed since the payer
    ///         paid. Callable by the provider (accepting the job) or the payer.
    function claimDeposit(DepositTerms calldata t) external nonReentrant {
        Service storage svc = services[t.serviceId];
        if (svc.provider == address(0)) revert InvalidService();
        if (!svc.active) revert ServiceInactive();
        if (t.payer == address(0)) revert ZeroAddress();
        if (block.timestamp > t.claimBy) revert ClaimWindowClosed();
        if (msg.sender != svc.provider && msg.sender != t.payer) revert NotAuthorized();
        // The deposit committed to these exact terms; the live service must still match.
        if (svc.token != t.token || svc.price != t.price || svc.deliveryWindow != t.deliveryWindow) {
            revert TermsMismatch();
        }

        bytes32 key = paymentKey(t.payer, t.requestId, t.serviceId);
        if (_payments[key].status != Status.None) revert PaymentExists();

        address vault = depositAddress(t);
        IERC20 token = IERC20(t.token);
        uint256 bal = token.balanceOf(vault);
        if (bal < t.price) revert InsufficientDeposit(bal, t.price);

        // Effects before the external pull (checks-effects-interactions).
        uint64 nowTs = uint64(block.timestamp);
        Payment storage p = _payments[key];
        p.serviceId = t.serviceId;
        p.payer = t.payer;
        p.payTo = svc.payTo;
        p.token = t.token;
        p.amount = t.price;
        p.escrowedAt = nowTs;
        p.deadline = nowTs + svc.deliveryWindow;
        p.status = Status.Escrowed;

        vault = _ensureVault(t, vault);
        uint256 before = token.balanceOf(address(this));
        DepositVault(vault).pull(token, address(this), t.price);
        if (token.balanceOf(address(this)) - before != t.price) revert AmountMismatch();

        emit PaymentEscrowed(t.requestId, t.serviceId, t.payer, t.token, t.price, p.deadline, 2);
        emit DepositClaimed(t.requestId, t.serviceId, t.payer, vault, t.price, depositSalt(t));
    }

    /// @notice Return tokens sitting in a deposit vault to the payer: an overpayment, a
    ///         deposit whose claim window closed, or any token sent to the address. The
    ///         recipient is always the terms-bound payer, so `recoverToken` is unrestricted.
    ///         Before a claim it is restricted to the payer or provider (anti-griefing);
    ///         after a claim, or after claimBy, or for a non-terms token, anyone may sweep.
    function refundExcessDeposit(DepositTerms calldata t, IERC20 recoverToken) external nonReentrant {
        if (t.payer == address(0)) revert ZeroAddress();
        address vault = depositAddress(t);
        uint256 bal = recoverToken.balanceOf(vault);
        if (bal == 0) revert NothingToRefund();

        bool claimed = _payments[paymentKey(t.payer, t.requestId, t.serviceId)].status != Status.None;
        bool recovering = address(recoverToken) != t.token;
        if (!claimed && !recovering && block.timestamp <= t.claimBy) {
            // A claimable, unclaimed deposit of the agreed token: only the two parties,
            // so a third party cannot bounce it and force the payer to re-pay HSP.
            address provider = services[t.serviceId].provider;
            if (msg.sender != t.payer && msg.sender != provider) revert NotAuthorized();
        }

        vault = _ensureVault(t, vault);
        DepositVault(vault).pull(recoverToken, t.payer, bal);
        emit ExcessDepositRefunded(t.requestId, t.serviceId, t.payer, address(recoverToken), bal);
    }

    /// @notice Provider confirms delivery with a hash of the delivered resource; releases funds.
    function confirmDelivery(address payer, bytes32 requestId, bytes32 serviceId, bytes32 deliveryHash)
        external
        nonReentrant
    {
        bytes32 key = paymentKey(payer, requestId, serviceId);
        Payment storage p = _payments[key];
        if (p.status != Status.Escrowed) revert PaymentNotEscrowed();
        Service storage svc = services[serviceId];
        if (svc.provider != msg.sender) revert NotProvider();
        if (deliveryHash == bytes32(0)) revert InvalidDeliveryHash();
        if (block.timestamp > p.deadline) revert DeliveryWindowClosed();

        p.status = Status.Released;
        p.deliveryHash = deliveryHash;
        IERC20(p.token).safeTransfer(p.payTo, p.amount);

        if (p.payer != svc.provider && p.payer != p.payTo) {
            ProviderActivity storage a = providerActivity[svc.provider];
            a.released += 1;
            a.volumeReleased += p.amount;
        }

        emit PaymentReleased(requestId, serviceId, payer, p.payTo, p.amount, deliveryHash);
    }

    /// @notice Refund the payer if the provider missed the delivery deadline. Callable by anyone.
    function refund(address payer, bytes32 requestId, bytes32 serviceId) external nonReentrant {
        bytes32 key = paymentKey(payer, requestId, serviceId);
        Payment storage p = _payments[key];
        if (p.status != Status.Escrowed) revert PaymentNotEscrowed();
        if (block.timestamp <= p.deadline) revert DeliveryWindowOpen();

        p.status = Status.Refunded;
        IERC20(p.token).safeTransfer(payer, p.amount);

        address provider = services[serviceId].provider;
        if (payer != provider && payer != p.payTo) {
            ProviderActivity storage a = providerActivity[provider];
            a.refunded += 1;
            a.volumeRefunded += p.amount;
        }

        emit PaymentRefunded(requestId, serviceId, payer, p.amount);
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

        bytes32 key = paymentKey(payer, requestId, serviceId);
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

        key = paymentKey(payer, requestId, serviceId);
        Payment storage p = _payments[key];
        if (p.status != Status.None) revert PaymentExists();

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

    function _emitEscrowed(bytes32 requestId, bytes32 key, uint8 rail) private {
        Payment storage p = _payments[key];
        emit PaymentEscrowed(requestId, p.serviceId, p.payer, p.token, p.amount, p.deadline, rail);
    }

    /// @dev Deploy the deal's clone if it does not exist yet, and return its address.
    function _ensureVault(DepositTerms calldata t, address vault) private returns (address) {
        if (vault.code.length == 0) {
            address deployed = Clones.cloneDeterministic(depositVaultImplementation, depositSalt(t));
            emit DepositVaultDeployed(deployed, t.payer, t.requestId, t.serviceId);
            return deployed;
        }
        return vault;
    }
}
