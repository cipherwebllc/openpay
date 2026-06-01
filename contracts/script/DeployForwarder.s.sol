// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Eip3009Forwarder} from "../src/Eip3009Forwarder.sol";

/// @dev Eip3009Forwarder を deploy する。constructor: (JPYC token, feeReceiver)。
///   feeReceiver は アプリの NEXT_PUBLIC_FEE_RECEIVER_ADDRESS と一致させること
///   (route の feeReceiver と不一致だと署名検証が通らない)。
///
/// 実行 (Amoy):
///   DEPLOY_JPYC=0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29 \
///   DEPLOY_FEE_RECEIVER=<あなたの feeReceiver> \
///   forge script contracts/script/DeployForwarder.s.sol:DeployForwarder \
///     --rpc-url "$NEXT_PUBLIC_POLYGON_AMOY_RPC_URL" \
///     --private-key "$DEPLOYER_PRIVATE_KEY" --broadcast
contract DeployForwarder is Script {
    function run() external {
        address jpyc = vm.envAddress("DEPLOY_JPYC");
        address feeReceiver = vm.envAddress("DEPLOY_FEE_RECEIVER");
        require(jpyc != address(0) && feeReceiver != address(0), "missing args");

        vm.startBroadcast();
        Eip3009Forwarder forwarder = new Eip3009Forwarder(IERC20(jpyc), feeReceiver);
        vm.stopBroadcast();

        console2.log("Eip3009Forwarder deployed at:", address(forwarder));
        console2.log("  token (JPYC):", address(forwarder.token()));
        console2.log("  feeReceiver :", forwarder.feeReceiver());
        console2.log(
            "-> set NEXT_PUBLIC_JPYC_FORWARDER_AMOY to the address above"
        );
    }
}
