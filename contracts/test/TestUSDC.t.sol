// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {TestUSDC} from "../src/TestUSDC.sol";

contract TestUSDCTest is Test {
    TestUSDC token;
    uint256 payerPk = 0xA11CE;
    address payer;
    address payee = address(0xBEEF);

    function setUp() public {
        token = new TestUSDC();
        payer = vm.addr(payerPk);
        token.mint(payer, 100e6);
    }

    function _sign(bytes32 typehash, address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce)
        internal
        view
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        bytes32 structHash = keccak256(abi.encode(typehash, from, to, value, validAfter, validBefore, nonce));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(), structHash));
        return vm.sign(payerPk, digest);
    }

    function test_DecimalsIsSix() public view {
        assertEq(token.decimals(), 6);
    }

    function test_MintCap() public {
        uint256 cap = token.MAX_MINT(); // cache: expectRevert applies to the very next call
        token.mint(address(1), cap);
        vm.expectRevert(TestUSDC.MintCapExceeded.selector);
        token.mint(address(1), cap + 1);
    }

    function test_TransferWithAuthorization() public {
        bytes32 nonce = keccak256("n1");
        (uint8 v, bytes32 r, bytes32 s) =
            _sign(token.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(), payer, payee, 10e6, 0, block.timestamp + 1 hours, nonce);
        // Anyone can relay a transferWithAuthorization.
        vm.prank(address(0xCAFE));
        token.transferWithAuthorization(payer, payee, 10e6, 0, block.timestamp + 1 hours, nonce, v, r, s);
        assertEq(token.balanceOf(payee), 10e6);
        assertTrue(token.authorizationState(payer, nonce));
    }

    function test_RevertWhen_NonceReused() public {
        bytes32 nonce = keccak256("n1");
        uint256 vb = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _sign(token.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(), payer, payee, 1e6, 0, vb, nonce);
        token.transferWithAuthorization(payer, payee, 1e6, 0, vb, nonce, v, r, s);
        vm.expectRevert(TestUSDC.AuthorizationAlreadyUsed.selector);
        token.transferWithAuthorization(payer, payee, 1e6, 0, vb, nonce, v, r, s);
    }

    function test_RevertWhen_Expired() public {
        bytes32 nonce = keccak256("n1");
        uint256 vb = block.timestamp + 10;
        (uint8 v, bytes32 r, bytes32 s) = _sign(token.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(), payer, payee, 1e6, 0, vb, nonce);
        vm.warp(vb);
        vm.expectRevert(TestUSDC.AuthorizationExpired.selector);
        token.transferWithAuthorization(payer, payee, 1e6, 0, vb, nonce, v, r, s);
    }

    function test_RevertWhen_NotYetValid() public {
        bytes32 nonce = keccak256("n1");
        uint256 va = block.timestamp + 100;
        (uint8 v, bytes32 r, bytes32 s) =
            _sign(token.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(), payer, payee, 1e6, va, va + 1 hours, nonce);
        vm.expectRevert(TestUSDC.AuthorizationNotYetValid.selector);
        token.transferWithAuthorization(payer, payee, 1e6, va, va + 1 hours, nonce, v, r, s);
    }

    function test_RevertWhen_TamperedValue() public {
        bytes32 nonce = keccak256("n1");
        uint256 vb = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _sign(token.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(), payer, payee, 1e6, 0, vb, nonce);
        vm.expectRevert(TestUSDC.InvalidSignature.selector);
        token.transferWithAuthorization(payer, payee, 2e6, 0, vb, nonce, v, r, s);
    }

    function test_ReceiveWithAuthorization_RequiresPayeeCaller() public {
        bytes32 nonce = keccak256("n1");
        uint256 vb = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _sign(token.RECEIVE_WITH_AUTHORIZATION_TYPEHASH(), payer, payee, 1e6, 0, vb, nonce);

        vm.prank(address(0xCAFE));
        vm.expectRevert(TestUSDC.CallerMustBePayee.selector);
        token.receiveWithAuthorization(payer, payee, 1e6, 0, vb, nonce, v, r, s);

        vm.prank(payee);
        token.receiveWithAuthorization(payer, payee, 1e6, 0, vb, nonce, v, r, s);
        assertEq(token.balanceOf(payee), 1e6);
    }

    function test_CancelAuthorization() public {
        bytes32 nonce = keccak256("n1");
        bytes32 structHash = keccak256(abi.encode(token.CANCEL_AUTHORIZATION_TYPEHASH(), payer, nonce));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(payerPk, digest);
        token.cancelAuthorization(payer, nonce, v, r, s);
        assertTrue(token.authorizationState(payer, nonce));

        uint256 vb = block.timestamp + 1 hours;
        (v, r, s) = _sign(token.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(), payer, payee, 1e6, 0, vb, nonce);
        vm.expectRevert(TestUSDC.AuthorizationAlreadyUsed.selector);
        token.transferWithAuthorization(payer, payee, 1e6, 0, vb, nonce, v, r, s);
    }
}
