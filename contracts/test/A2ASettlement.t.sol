// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {A2ASettlement} from "../src/A2ASettlement.sol";
import {TestUSDC} from "../src/TestUSDC.sol";

contract A2ASettlementTest is Test {
    A2ASettlement settlement;
    TestUSDC usdc;

    uint256 payerPk = 0xA11CE;
    address payer;
    address provider = address(0x9001);
    address payTo = address(0x9002);
    address relayer = address(0x9003);

    bytes32 constant SERVICE = keccak256("hsk-market-snapshot");
    bytes32 constant REQ = keccak256("request-1");
    uint256 constant PRICE = 1e6; // 1 tUSDC
    uint64 constant WINDOW = 1 hours;

    function setUp() public {
        settlement = new A2ASettlement();
        usdc = new TestUSDC();
        payer = vm.addr(payerPk);
        usdc.mint(payer, 100e6);

        vm.prank(provider);
        settlement.registerService(SERVICE, payTo, address(usdc), PRICE, WINDOW);
    }

    // ─────────────────────────── helpers ───────────────────────────

    function _signReceive(bytes32 requestId, bytes32 serviceId, uint256 value, uint256 validBefore)
        internal
        view
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        bytes32 nonce = settlement.authorizationNonce(requestId, serviceId);
        bytes32 structHash = keccak256(
            abi.encode(
                usdc.RECEIVE_WITH_AUTHORIZATION_TYPEHASH(), payer, address(settlement), value, 0, validBefore, nonce
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), structHash));
        return vm.sign(payerPk, digest);
    }

    function _escrow(bytes32 requestId) internal {
        uint256 vb = block.timestamp + 10 minutes;
        (uint8 v, bytes32 r, bytes32 s) = _signReceive(requestId, SERVICE, PRICE, vb);
        vm.prank(relayer);
        settlement.settleWithAuthorization(requestId, SERVICE, payer, 0, vb, v, r, s);
    }

    // ─────────────────────────── services ───────────────────────────

    function test_RegisterService() public view {
        (address p, address to, address token, uint256 price, uint64 window, bool active) = settlement.services(SERVICE);
        assertEq(p, provider);
        assertEq(to, payTo);
        assertEq(token, address(usdc));
        assertEq(price, PRICE);
        assertEq(window, WINDOW);
        assertTrue(active);
    }

    function test_RevertWhen_NonProviderUpdatesService() public {
        vm.prank(address(0xBAD));
        vm.expectRevert(A2ASettlement.NotProvider.selector);
        settlement.registerService(SERVICE, address(0xBAD), address(usdc), 1, WINDOW);
    }

    function test_RevertWhen_InvalidServiceParams() public {
        bytes32 svc = keccak256("other");
        vm.startPrank(provider);
        vm.expectRevert(A2ASettlement.ZeroAddress.selector);
        settlement.registerService(svc, address(0), address(usdc), PRICE, WINDOW);
        vm.expectRevert(A2ASettlement.InvalidPrice.selector);
        settlement.registerService(svc, payTo, address(usdc), 0, WINDOW);
        vm.expectRevert(A2ASettlement.InvalidDeliveryWindow.selector);
        settlement.registerService(svc, payTo, address(usdc), PRICE, 1);
        vm.stopPrank();
    }

    function test_RevertWhen_ServiceInactive() public {
        vm.prank(provider);
        settlement.setServiceActive(SERVICE, false);
        uint256 vb = block.timestamp + 10 minutes;
        (uint8 v, bytes32 r, bytes32 s) = _signReceive(REQ, SERVICE, PRICE, vb);
        vm.expectRevert(A2ASettlement.ServiceInactive.selector);
        settlement.settleWithAuthorization(REQ, SERVICE, payer, 0, vb, v, r, s);
    }

    // ─────────────────────────── gasless escrow ───────────────────────────

    function test_SettleWithAuthorization_Escrows() public {
        uint256 payerBefore = usdc.balanceOf(payer);
        _escrow(REQ);

        assertEq(usdc.balanceOf(payer), payerBefore - PRICE);
        assertEq(usdc.balanceOf(address(settlement)), PRICE);
        assertEq(usdc.balanceOf(payTo), 0, "not released before delivery");

        A2ASettlement.Payment memory p = settlement.getPayment(payer, REQ);
        assertEq(uint8(p.status), uint8(A2ASettlement.Status.Escrowed));
        assertEq(p.amount, PRICE);
        assertEq(p.deadline, uint64(block.timestamp) + WINDOW);
        assertEq(p.payTo, payTo);
    }

    function test_RevertWhen_SignatureBoundToOtherRequest() public {
        uint256 vb = block.timestamp + 10 minutes;
        // Signed for REQ, submitted for a different request id.
        (uint8 v, bytes32 r, bytes32 s) = _signReceive(REQ, SERVICE, PRICE, vb);
        vm.expectRevert(TestUSDC.InvalidSignature.selector);
        settlement.settleWithAuthorization(keccak256("other-request"), SERVICE, payer, 0, vb, v, r, s);
    }

    function test_RevertWhen_Replay() public {
        _escrow(REQ);
        uint256 vb = block.timestamp + 10 minutes;
        (uint8 v, bytes32 r, bytes32 s) = _signReceive(REQ, SERVICE, PRICE, vb);
        vm.expectRevert(A2ASettlement.PaymentExists.selector);
        settlement.settleWithAuthorization(REQ, SERVICE, payer, 0, vb, v, r, s);
    }

    function test_RevertWhen_PriceRaisedAfterSigning() public {
        uint256 vb = block.timestamp + 10 minutes;
        (uint8 v, bytes32 r, bytes32 s) = _signReceive(REQ, SERVICE, PRICE, vb);
        vm.prank(provider);
        settlement.registerService(SERVICE, payTo, address(usdc), PRICE * 5, WINDOW);
        // The payer only authorized PRICE; the provider cannot overcharge.
        vm.expectRevert(TestUSDC.InvalidSignature.selector);
        settlement.settleWithAuthorization(REQ, SERVICE, payer, 0, vb, v, r, s);
    }

    function test_RequestIdsAreScopedPerPayer() public {
        // Another payer using the same request id does not block this payer.
        address other = address(0x7777);
        usdc.mint(other, 10e6);
        vm.startPrank(other);
        usdc.approve(address(settlement), PRICE);
        settlement.settle(REQ, SERVICE);
        vm.stopPrank();

        _escrow(REQ);
        assertEq(uint8(settlement.getPayment(payer, REQ).status), uint8(A2ASettlement.Status.Escrowed));
    }

    // ─────────────────────────── approve-path escrow ───────────────────────────

    function test_Settle_WithApproval() public {
        vm.startPrank(payer);
        usdc.approve(address(settlement), PRICE);
        settlement.settle(REQ, SERVICE);
        vm.stopPrank();
        assertEq(usdc.balanceOf(address(settlement)), PRICE);
    }

    // ─────────────────────────── delivery & refund ───────────────────────────

    function test_ConfirmDelivery_ReleasesToPayTo() public {
        _escrow(REQ);
        bytes32 h = keccak256("resource-bytes");
        vm.prank(provider);
        settlement.confirmDelivery(payer, REQ, h);

        assertEq(usdc.balanceOf(payTo), PRICE);
        assertEq(usdc.balanceOf(address(settlement)), 0);
        A2ASettlement.Payment memory p = settlement.getPayment(payer, REQ);
        assertEq(uint8(p.status), uint8(A2ASettlement.Status.Released));
        assertEq(p.deliveryHash, h);
    }

    function test_RevertWhen_NonProviderConfirms() public {
        _escrow(REQ);
        vm.prank(address(0xBAD));
        vm.expectRevert(A2ASettlement.NotProvider.selector);
        settlement.confirmDelivery(payer, REQ, keccak256("x"));
    }

    function test_RevertWhen_ZeroDeliveryHash() public {
        _escrow(REQ);
        vm.prank(provider);
        vm.expectRevert(A2ASettlement.InvalidDeliveryHash.selector);
        settlement.confirmDelivery(payer, REQ, bytes32(0));
    }

    function test_RevertWhen_DeliveryAfterDeadline() public {
        _escrow(REQ);
        vm.warp(block.timestamp + WINDOW + 1);
        vm.prank(provider);
        vm.expectRevert(A2ASettlement.DeliveryWindowClosed.selector);
        settlement.confirmDelivery(payer, REQ, keccak256("x"));
    }

    function test_RevertWhen_RefundBeforeDeadline() public {
        _escrow(REQ);
        vm.expectRevert(A2ASettlement.DeliveryWindowOpen.selector);
        settlement.refund(payer, REQ);
    }

    function test_Refund_AfterDeadline() public {
        uint256 payerBefore = usdc.balanceOf(payer);
        _escrow(REQ);
        vm.warp(block.timestamp + WINDOW + 1);
        vm.prank(address(0xD00D)); // anyone can trigger
        settlement.refund(payer, REQ);

        assertEq(usdc.balanceOf(payer), payerBefore);
        assertEq(uint8(settlement.getPayment(payer, REQ).status), uint8(A2ASettlement.Status.Refunded));
    }

    function test_RevertWhen_DoubleRefundOrDeliverAfterRefund() public {
        _escrow(REQ);
        vm.warp(block.timestamp + WINDOW + 1);
        settlement.refund(payer, REQ);

        vm.expectRevert(A2ASettlement.PaymentNotEscrowed.selector);
        settlement.refund(payer, REQ);

        vm.prank(provider);
        vm.expectRevert(A2ASettlement.PaymentNotEscrowed.selector);
        settlement.confirmDelivery(payer, REQ, keccak256("x"));
    }

    function test_RevertWhen_RefundAfterRelease() public {
        _escrow(REQ);
        vm.prank(provider);
        settlement.confirmDelivery(payer, REQ, keccak256("x"));
        vm.warp(block.timestamp + WINDOW + 1);
        vm.expectRevert(A2ASettlement.PaymentNotEscrowed.selector);
        settlement.refund(payer, REQ);
    }

    // ─────────────────────────── external anchoring ───────────────────────────

    function test_AnchorExternalSettlement() public {
        vm.prank(provider);
        settlement.anchorExternalSettlement(REQ, SERVICE, payer, PRICE, "HSP", "flow_123", keccak256("x"));
        assertTrue(settlement.anchored(settlement.paymentKey(payer, REQ)));

        vm.prank(provider);
        vm.expectRevert(A2ASettlement.AlreadyAnchored.selector);
        settlement.anchorExternalSettlement(REQ, SERVICE, payer, PRICE, "HSP", "flow_123", keccak256("x"));
    }

    function test_RevertWhen_NonProviderAnchors() public {
        vm.prank(address(0xBAD));
        vm.expectRevert(A2ASettlement.NotProvider.selector);
        settlement.anchorExternalSettlement(REQ, SERVICE, payer, PRICE, "HSP", "flow_123", keccak256("x"));
    }

    // ─────────────────────────── fuzz ───────────────────────────

    function testFuzz_EscrowAndReleaseConservesFunds(uint96 price, bytes32 requestId) public {
        vm.assume(price > 0 && price <= 1_000e6);
        bytes32 svc = keccak256("fuzz-service");
        vm.prank(provider);
        settlement.registerService(svc, payTo, address(usdc), price, WINDOW);
        usdc.mint(payer, 1_000e6);

        uint256 vb = block.timestamp + 10 minutes;
        (uint8 v, bytes32 r, bytes32 s) = _signReceive(requestId, svc, price, vb);
        settlement.settleWithAuthorization(requestId, svc, payer, 0, vb, v, r, s);

        vm.prank(provider);
        settlement.confirmDelivery(payer, requestId, keccak256(abi.encode(requestId)));
        assertEq(usdc.balanceOf(payTo), price);
        assertEq(usdc.balanceOf(address(settlement)), 0);
    }
}
