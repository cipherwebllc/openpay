// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {OpenPayLicense1155} from "../src/OpenPayLicense1155.sol";

/// @dev OpenPayLicense1155 を deploy。LICENSE_OWNER (cold) / LICENSE_MINTER (hot) は別 address。
///   deployer が owner である必要はない。LICENSE_MINTER=0 は登録/mint を停止した初期状態。
///   実行手順・Amoy → Polygon の順序は contracts/README.md を参照。
contract DeployLicense is Script {
    function run() external {
        address owner = vm.envAddress("LICENSE_OWNER");
        address minter = vm.envAddress("LICENSE_MINTER");

        vm.startBroadcast();
        OpenPayLicense1155 license = new OpenPayLicense1155(owner, minter);
        vm.stopBroadcast();

        console2.log("OpenPayLicense1155 deployed at:", address(license));
        console2.log("  owner (cold):", license.owner());
        console2.log("  minter (hot):", license.minter());
        console2.log(
            "-> set NEXT_PUBLIC_LICENSE_NFT_{AMOY|POLYGON} (match the deployed chain) to the address above"
        );
    }
}
