// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Eip3009Forwarder} from "../src/Eip3009Forwarder.sol";

interface IERC3009Min {
    function authorizationState(address authorizer, bytes32 nonce) external view returns (bool);
}

/// @dev 実 JPYC (Polygon Amoy fork) に対する settle 統合テスト。`AMOY_RPC_URL` 設定時のみ実行
///   (未設定なら skip するので通常の `forge test` は hermetic)。mock の忠実性 + 実 EIP-712 domain
///   {JPY Coin / 1} + receiveWithAuthorization が settle と通ることを実トークンで確認する。
///   実行: AMOY_RPC_URL=<rpc> forge test --match-contract Fork -vvv
contract Eip3009ForwarderForkTest is Test {
    address internal constant JPYC = 0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29;

    bytes32 internal constant EIP712_DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );
    bytes32 internal constant RECEIVE_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    bool internal skipAll;
    Eip3009Forwarder internal forwarder;

    uint256 internal constant CUSTOMER_PK = 0xC0FFEE;
    address internal customer;
    address internal merchant = address(0xBEEF);
    address internal feeReceiver = address(0xFEE);

    function setUp() public {
        string memory rpc = vm.envOr("AMOY_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            skipAll = true;
            return;
        }
        vm.createSelectFork(rpc);
        customer = vm.addr(CUSTOMER_PK);
        forwarder = new Eip3009Forwarder(IERC20(JPYC), feeReceiver);
    }

    function _domainSeparator() internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH,
                keccak256(bytes("JPY Coin")),
                keccak256(bytes("1")),
                block.chainid,
                JPYC
            )
        );
    }

    function test_fork_settle_realJpyc() public {
        if (skipAll) {
            vm.skip(true);
            return;
        }

        uint256 mv = 1000e18;
        uint256 fv = 3e18;
        uint256 value = mv + fv;
        uint256 validAfter = 0;
        uint256 validBefore = type(uint256).max;
        bytes32 salt = keccak256("fork-salt");

        // 実 JPYC 残高を customer に用意 (deal が balance slot を解決)。
        deal(JPYC, customer, value);
        assertEq(IERC20(JPYC).balanceOf(customer), value, "deal funded JPYC");

        bytes32 nonce = keccak256(
            abi.encode(
                forwarder.COMMIT_VERSION(),
                customer,
                merchant,
                mv,
                feeReceiver,
                fv,
                validAfter,
                validBefore,
                salt,
                block.chainid,
                address(forwarder)
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(
                RECEIVE_TYPEHASH,
                customer,
                address(forwarder),
                value,
                validAfter,
                validBefore,
                nonce
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(CUSTOMER_PK, digest);

        forwarder.settle(customer, merchant, mv, fv, validAfter, validBefore, salt, v, r, s);

        assertEq(IERC20(JPYC).balanceOf(merchant), mv, "merchant got mv on real JPYC");
        assertEq(IERC20(JPYC).balanceOf(feeReceiver), fv, "feeReceiver got fv");
        assertEq(IERC20(JPYC).balanceOf(customer), 0, "customer paid total");
        assertTrue(
            IERC3009Min(JPYC).authorizationState(customer, nonce), "nonce consumed on real JPYC"
        );
    }
}
