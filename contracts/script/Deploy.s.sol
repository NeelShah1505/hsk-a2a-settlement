// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {A2ASettlement} from "../src/A2ASettlement.sol";
import {TestUSDC} from "../src/TestUSDC.sol";

/// @notice Deploys A2ASettlement (and TestUSDC on test networks), registers the demo
///         services, and writes addresses to ../deployments/<chainId>.json.
///
/// Env:
///   DEPLOYER_PRIVATE_KEY  deployer, relayer and service provider (needs native HSK)
///   DEPLOY_TEST_TOKEN     "true" (default) deploys TestUSDC; set "false" on mainnet
///   SETTLEMENT_TOKEN      token address to use when DEPLOY_TEST_TOKEN=false (optional)
///   PROVIDER_PAY_TO       payout address for released funds (default: deployer)
///   PAYER_ADDRESS         gasless payer agent to fund with TestUSDC (optional)
///   DELIVERY_WINDOW       seconds the provider has to deliver (default 3600)
contract Deploy is Script {
    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(pk);
        bool deployTestToken = vm.envOr("DEPLOY_TEST_TOKEN", true);
        address payTo = vm.envOr("PROVIDER_PAY_TO", deployer);
        address payerAgent = vm.envOr("PAYER_ADDRESS", address(0));
        uint64 window = uint64(vm.envOr("DELIVERY_WINDOW", uint256(3600)));

        vm.startBroadcast(pk);

        address token;
        if (deployTestToken) {
            TestUSDC usdc = new TestUSDC();
            token = address(usdc);
            if (payerAgent != address(0)) usdc.mint(payerAgent, usdc.MAX_MINT());
        } else {
            token = vm.envOr("SETTLEMENT_TOKEN", address(0));
        }

        A2ASettlement settlement = new A2ASettlement();

        // Prices in token units (6 decimals): 1 and 2 stablecoin units.
        if (token != address(0)) {
            settlement.registerService(keccak256("hsk-market-snapshot"), payTo, token, 1e6, window);
            settlement.registerService(keccak256("settlement-receipt-api"), payTo, token, 2e6, window);
        }

        vm.stopBroadcast();

        console2.log("A2ASettlement:", address(settlement));
        console2.log("Token:        ", token);

        // Only record real deployments: a dry run must never produce a deployment file.
        if (!vm.isContext(VmSafe.ForgeContext.ScriptBroadcast)) {
            console2.log("Dry run: deployments file not written.");
            return;
        }

        string memory obj = "deployment";
        vm.serializeUint(obj, "chainId", block.chainid);
        vm.serializeAddress(obj, "deployer", deployer);
        vm.serializeAddress(obj, "provider", deployer);
        vm.serializeAddress(obj, "payTo", payTo);
        vm.serializeAddress(obj, "token", token);
        vm.serializeBool(obj, "testToken", deployTestToken);
        vm.serializeUint(obj, "deliveryWindow", window);
        vm.serializeUint(obj, "deployedAtBlock", block.number);
        string memory json = vm.serializeAddress(obj, "settlement", address(settlement));
        string memory path = string.concat(vm.projectRoot(), "/../deployments/", vm.toString(block.chainid), ".json");
        vm.writeJson(json, path);
        console2.log("Written to:   ", path);
    }
}
