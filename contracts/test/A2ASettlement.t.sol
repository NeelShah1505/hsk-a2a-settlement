// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {A2ASettlement} from "../src/A2ASettlement.sol";
import {DepositVault} from "../src/DepositVault.sol";
import {TestUSDC} from "../src/TestUSDC.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

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

    function _terms() internal view returns (A2ASettlement.DepositTerms memory) {
        return A2ASettlement.DepositTerms({
            payer: payer,
            requestId: REQ,
            serviceId: SERVICE,
            token: address(usdc),
            price: PRICE,
            deliveryWindow: WINDOW,
            claimBy: uint64(block.timestamp + 1 hours)
        });
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

        A2ASettlement.Payment memory p = settlement.getPayment(payer, REQ, SERVICE);
        assertEq(uint8(p.status), uint8(A2ASettlement.Status.Escrowed));
        assertEq(p.amount, PRICE);
        assertEq(p.deadline, uint64(block.timestamp) + WINDOW);
        assertEq(p.payTo, payTo);
    }

    function test_RevertWhen_SignatureBoundToOtherRequest() public {
        uint256 vb = block.timestamp + 10 minutes;
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
        vm.expectRevert(TestUSDC.InvalidSignature.selector);
        settlement.settleWithAuthorization(REQ, SERVICE, payer, 0, vb, v, r, s);
    }

    function test_Settle_WithApproval() public {
        vm.startPrank(payer);
        usdc.approve(address(settlement), PRICE);
        settlement.settle(REQ, SERVICE);
        vm.stopPrank();
        assertEq(usdc.balanceOf(address(settlement)), PRICE);
    }

    // ─────────────────────────── payment keying ───────────────────────────

    function test_PaymentsKeyedByService_NoCrossServiceSquat() public {
        // Same payer + requestId, two different services: both can escrow independently.
        bytes32 svc2 = keccak256("settlement-receipt-api");
        vm.prank(provider);
        settlement.registerService(svc2, payTo, address(usdc), PRICE, WINDOW);

        _escrow(REQ); // SERVICE

        uint256 vb = block.timestamp + 10 minutes;
        (uint8 v, bytes32 r, bytes32 s) = _signReceive(REQ, svc2, PRICE, vb);
        settlement.settleWithAuthorization(REQ, svc2, payer, 0, vb, v, r, s);

        assertEq(uint8(settlement.getPayment(payer, REQ, SERVICE).status), uint8(A2ASettlement.Status.Escrowed));
        assertEq(uint8(settlement.getPayment(payer, REQ, svc2).status), uint8(A2ASettlement.Status.Escrowed));
        assertEq(usdc.balanceOf(address(settlement)), 2 * PRICE);
    }

    // ─────────────────────────── delivery & refund ───────────────────────────

    function test_ConfirmDelivery_ReleasesToPayTo() public {
        _escrow(REQ);
        bytes32 h = keccak256("resource-bytes");
        vm.prank(provider);
        settlement.confirmDelivery(payer, REQ, SERVICE, h);

        assertEq(usdc.balanceOf(payTo), PRICE);
        assertEq(usdc.balanceOf(address(settlement)), 0);
        A2ASettlement.Payment memory p = settlement.getPayment(payer, REQ, SERVICE);
        assertEq(uint8(p.status), uint8(A2ASettlement.Status.Released));
        assertEq(p.deliveryHash, h);

        (uint256 released,, uint256 vol,) = settlement.providerActivity(provider);
        assertEq(released, 1);
        assertEq(vol, PRICE);
    }

    function test_RevertWhen_NonProviderConfirms() public {
        _escrow(REQ);
        vm.prank(address(0xBAD));
        vm.expectRevert(A2ASettlement.NotProvider.selector);
        settlement.confirmDelivery(payer, REQ, SERVICE, keccak256("x"));
    }

    function test_RevertWhen_ZeroDeliveryHash() public {
        _escrow(REQ);
        vm.prank(provider);
        vm.expectRevert(A2ASettlement.InvalidDeliveryHash.selector);
        settlement.confirmDelivery(payer, REQ, SERVICE, bytes32(0));
    }

    function test_RevertWhen_DeliveryAfterDeadline() public {
        _escrow(REQ);
        vm.warp(block.timestamp + WINDOW + 1);
        vm.prank(provider);
        vm.expectRevert(A2ASettlement.DeliveryWindowClosed.selector);
        settlement.confirmDelivery(payer, REQ, SERVICE, keccak256("x"));
    }

    function test_RevertWhen_RefundBeforeDeadline() public {
        _escrow(REQ);
        vm.expectRevert(A2ASettlement.DeliveryWindowOpen.selector);
        settlement.refund(payer, REQ, SERVICE);
    }

    function test_Refund_AfterDeadline() public {
        uint256 payerBefore = usdc.balanceOf(payer);
        _escrow(REQ);
        vm.warp(block.timestamp + WINDOW + 1);
        vm.prank(address(0xD00D));
        settlement.refund(payer, REQ, SERVICE);

        assertEq(usdc.balanceOf(payer), payerBefore);
        assertEq(uint8(settlement.getPayment(payer, REQ, SERVICE).status), uint8(A2ASettlement.Status.Refunded));
        (, uint256 refunded,, uint256 volRef) = settlement.providerActivity(provider);
        assertEq(refunded, 1);
        assertEq(volRef, PRICE);
    }

    function test_RevertWhen_DoubleRefundOrDeliverAfterRefund() public {
        _escrow(REQ);
        vm.warp(block.timestamp + WINDOW + 1);
        settlement.refund(payer, REQ, SERVICE);

        vm.expectRevert(A2ASettlement.PaymentNotEscrowed.selector);
        settlement.refund(payer, REQ, SERVICE);

        vm.prank(provider);
        vm.expectRevert(A2ASettlement.PaymentNotEscrowed.selector);
        settlement.confirmDelivery(payer, REQ, SERVICE, keccak256("x"));
    }

    // ─────────────────────────── deposit vaults ───────────────────────────

    function test_DepositVaultImplementation_SettlementIsContract() public view {
        DepositVault impl = DepositVault(settlement.depositVaultImplementation());
        assertEq(impl.settlement(), address(settlement));
    }

    function test_DepositAddress_MatchesDeployedClone_AndFundThenClaim() public {
        A2ASettlement.DepositTerms memory t = _terms();
        address predicted = settlement.depositAddress(t);
        assertEq(predicted.code.length, 0, "counterfactual: no code yet");

        // Fund the address BEFORE any clone exists (as HSP's relayer / a wallet would).
        vm.prank(payer);
        usdc.transfer(predicted, PRICE);

        vm.prank(provider);
        settlement.claimDeposit(t);

        assertGt(predicted.code.length, 0, "clone deployed on claim");
        assertEq(DepositVault(predicted).settlement(), address(settlement));
        assertEq(usdc.balanceOf(address(settlement)), PRICE);
        assertEq(usdc.balanceOf(predicted), 0);
        assertEq(uint8(settlement.getPayment(payer, REQ, SERVICE).status), uint8(A2ASettlement.Status.Escrowed));
    }

    function test_Deposit_FullLifecycle_Release() public {
        A2ASettlement.DepositTerms memory t = _terms();
        address _d = settlement.depositAddress(t);
        vm.prank(payer);
        usdc.transfer(_d, PRICE);
        vm.prank(provider);
        settlement.claimDeposit(t);
        vm.prank(provider);
        settlement.confirmDelivery(payer, REQ, SERVICE, keccak256("resource"));
        assertEq(usdc.balanceOf(payTo), PRICE);
    }

    function test_DepositVault_PullOnlyBySettlement() public {
        A2ASettlement.DepositTerms memory t = _terms();
        address _d = settlement.depositAddress(t);
        vm.prank(payer);
        usdc.transfer(_d, PRICE);
        vm.prank(provider);
        settlement.claimDeposit(t); // deploys the clone
        address vault = settlement.depositAddress(t);

        address impl = settlement.depositVaultImplementation();
        for (uint256 i = 0; i < 4; i++) {
            address caller = [payer, provider, relayer, impl][i];
            vm.prank(caller);
            vm.expectRevert(DepositVault.NotSettlement.selector);
            DepositVault(vault).pull(IERC20(address(usdc)), caller, 1);
        }
    }

    function test_RevertWhen_ClaimDepositUnderfunded() public {
        A2ASettlement.DepositTerms memory t = _terms();
        address _d = settlement.depositAddress(t);
        vm.prank(payer);
        usdc.transfer(_d, PRICE - 1);
        vm.prank(provider);
        vm.expectRevert(abi.encodeWithSelector(A2ASettlement.InsufficientDeposit.selector, PRICE - 1, PRICE));
        settlement.claimDeposit(t);
        // No clone deployed on the failed path.
        assertEq(settlement.depositAddress(t).code.length, 0);
    }

    function test_RevertWhen_ClaimDepositTermsMismatch() public {
        A2ASettlement.DepositTerms memory t = _terms();
        address _d = settlement.depositAddress(t);
        vm.prank(payer);
        usdc.transfer(_d, PRICE);
        // Provider raises the price after the payer funded the terms-bound address.
        vm.prank(provider);
        settlement.registerService(SERVICE, payTo, address(usdc), PRICE * 5, WINDOW);
        vm.prank(provider);
        vm.expectRevert(A2ASettlement.TermsMismatch.selector);
        settlement.claimDeposit(t);
    }

    function test_RevertWhen_ClaimDepositAfterClaimBy() public {
        A2ASettlement.DepositTerms memory t = _terms();
        address _d = settlement.depositAddress(t);
        vm.prank(payer);
        usdc.transfer(_d, PRICE);
        vm.warp(t.claimBy + 1);
        vm.prank(provider);
        vm.expectRevert(A2ASettlement.ClaimWindowClosed.selector);
        settlement.claimDeposit(t);
    }

    function test_RevertWhen_ClaimDepositByStranger() public {
        A2ASettlement.DepositTerms memory t = _terms();
        address _d = settlement.depositAddress(t);
        vm.prank(payer);
        usdc.transfer(_d, PRICE);
        vm.prank(address(0xBAD));
        vm.expectRevert(A2ASettlement.NotAuthorized.selector);
        settlement.claimDeposit(t);
    }

    function test_RefundExcessDeposit_PayerGetsOverpaymentBack() public {
        A2ASettlement.DepositTerms memory t = _terms();
        uint256 payerBefore = usdc.balanceOf(payer);
        address _d = settlement.depositAddress(t);
        vm.prank(payer);
        usdc.transfer(_d, PRICE + 5e6); // overpay by 5

        vm.prank(provider);
        settlement.claimDeposit(t); // escrows exactly PRICE

        // Anyone can sweep the post-claim excess back to the payer.
        vm.prank(address(0xD00D));
        settlement.refundExcessDeposit(t, IERC20(address(usdc)));

        assertEq(usdc.balanceOf(settlement.depositAddress(t)), 0);
        assertEq(usdc.balanceOf(payer), payerBefore - PRICE); // only the price left the payer
    }

    function test_RefundExcessDeposit_StrangerCannotBounceUnclaimed() public {
        A2ASettlement.DepositTerms memory t = _terms();
        address _d = settlement.depositAddress(t);
        vm.prank(payer);
        usdc.transfer(_d, PRICE);
        // A third party tries to bounce a claimable, unclaimed, agreed-token deposit.
        vm.prank(address(0xBAD));
        vm.expectRevert(A2ASettlement.NotAuthorized.selector);
        settlement.refundExcessDeposit(t, IERC20(address(usdc)));
        // The payer can.
        vm.prank(payer);
        settlement.refundExcessDeposit(t, IERC20(address(usdc)));
        assertEq(usdc.balanceOf(settlement.depositAddress(t)), 0);
    }

    function test_RefundExcessDeposit_RecoversWrongTokenForAnyone() public {
        A2ASettlement.DepositTerms memory t = _terms();
        TestUSDC other = new TestUSDC();
        address vault = settlement.depositAddress(t);
        other.mint(address(this), 10e6);
        other.transfer(vault, 7e6); // a different token lands at the deposit address

        // Recovering a non-terms token is permissionless and always goes to the payer.
        vm.prank(address(0xBAD));
        settlement.refundExcessDeposit(t, IERC20(address(other)));
        assertEq(other.balanceOf(payer), 7e6);
    }

    function test_RefundExcessDeposit_SweepAfterClaimByByAnyone() public {
        A2ASettlement.DepositTerms memory t = _terms();
        address _d = settlement.depositAddress(t);
        vm.prank(payer);
        usdc.transfer(_d, PRICE);
        vm.warp(t.claimBy + 1); // claim window closed; deposit abandoned
        uint256 payerBefore = usdc.balanceOf(payer);
        vm.prank(address(0xD00D));
        settlement.refundExcessDeposit(t, IERC20(address(usdc)));
        assertEq(usdc.balanceOf(payer), payerBefore + PRICE);
    }

    function test_DepositStatus_View() public {
        A2ASettlement.DepositTerms memory t = _terms();
        (address vault, uint256 bal, bool deployed, bool claimable, A2ASettlement.Status st) =
            settlement.depositStatus(t);
        assertEq(vault, settlement.depositAddress(t));
        assertEq(bal, 0);
        assertFalse(deployed);
        assertFalse(claimable);
        assertEq(uint8(st), uint8(A2ASettlement.Status.None));

        vm.prank(payer);
        usdc.transfer(vault, PRICE);
        (, bal,, claimable,) = settlement.depositStatus(t);
        assertEq(bal, PRICE);
        assertTrue(claimable);
    }

    // ─────────────────────────── external anchoring ───────────────────────────

    function test_AnchorExternalSettlement() public {
        vm.prank(provider);
        settlement.anchorExternalSettlement(REQ, SERVICE, payer, PRICE, "HSP", "flow_123", keccak256("x"));
        assertTrue(settlement.anchored(settlement.paymentKey(payer, REQ, SERVICE)));

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
        bytes32 nonce = settlement.authorizationNonce(requestId, svc);
        bytes32 structHash = keccak256(
            abi.encode(usdc.RECEIVE_WITH_AUTHORIZATION_TYPEHASH(), payer, address(settlement), uint256(price), uint256(0), vb, nonce)
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(payerPk, digest);
        settlement.settleWithAuthorization(requestId, svc, payer, 0, vb, v, r, s);

        vm.prank(provider);
        settlement.confirmDelivery(payer, requestId, svc, keccak256(abi.encode(requestId)));
        assertEq(usdc.balanceOf(payTo), price);
        assertEq(usdc.balanceOf(address(settlement)), 0);
    }

    function testFuzz_DepositConservesFunds(uint96 price, bytes32 requestId) public {
        vm.assume(price > 0 && price <= 1_000e6);
        bytes32 svc = keccak256("fuzz-deposit");
        vm.prank(provider);
        settlement.registerService(svc, payTo, address(usdc), price, WINDOW);

        A2ASettlement.DepositTerms memory t = A2ASettlement.DepositTerms({
            payer: payer,
            requestId: requestId,
            serviceId: svc,
            token: address(usdc),
            price: price,
            deliveryWindow: WINDOW,
            claimBy: uint64(block.timestamp + 1 hours)
        });
        usdc.mint(payer, 1_000e6);
        address _d = settlement.depositAddress(t);
        vm.prank(payer);
        usdc.transfer(_d, price);

        vm.prank(provider);
        settlement.claimDeposit(t);
        vm.prank(provider);
        settlement.confirmDelivery(payer, requestId, svc, keccak256(abi.encode(requestId)));
        assertEq(usdc.balanceOf(payTo), price);
        assertEq(usdc.balanceOf(address(settlement)), 0);
    }
}
