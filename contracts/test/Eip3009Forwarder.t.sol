// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Eip3009Forwarder} from "../src/Eip3009Forwarder.sol";
import {MockEip3009Token} from "./mocks/MockEip3009Token.sol";

contract Eip3009ForwarderTest is Test {
    MockEip3009Token internal token;
    Eip3009Forwarder internal forwarder;

    uint256 internal constant CUSTOMER_PK = 0xA11CE;
    address internal customer;
    address internal merchant = address(0xBEEF);
    address internal feeReceiver = address(0xFEE);

    uint256 internal validAfter = 0;
    uint256 internal validBefore = type(uint256).max;

    bytes32 internal constant RECEIVE_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    function setUp() public {
        vm.warp(1_700_000_000);
        customer = vm.addr(CUSTOMER_PK);
        token = new MockEip3009Token();
        forwarder = new Eip3009Forwarder(IERC20(address(token)), feeReceiver);
        token.mint(customer, 1_000_000 ether);
    }

    // forwarder が settle 内で計算するのと同一の nonce を組む (split を commit)。
    function _commitNonce(address merchant_, uint256 mv, uint256 fv, bytes32 salt)
        internal
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encode(
                forwarder.COMMIT_VERSION(),
                customer,
                merchant_,
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
    }

    // 顧客が receiveWithAuthorization(to=forwarder, value=mv+fv, nonce=commit) に署名。
    function _sign(address merchant_, uint256 mv, uint256 fv, bytes32 salt)
        internal
        view
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        bytes32 nonce = _commitNonce(merchant_, mv, fv, salt);
        bytes32 structHash = keccak256(
            abi.encode(
                RECEIVE_TYPEHASH,
                customer,
                address(forwarder),
                mv + fv,
                validAfter,
                validBefore,
                nonce
            )
        );
        bytes32 digest =
            keccak256(abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(), structHash));
        (v, r, s) = vm.sign(CUSTOMER_PK, digest);
    }

    // --- happy path -------------------------------------------------------

    function test_settle_customerMode_splitsCorrectly() public {
        // customer 上乗せ: 顧客が amount(1000)+gas(3) を払い、店舗は満額、OpenPay が gas を回収。
        uint256 mv = 1000 ether;
        uint256 fv = 3 ether;
        bytes32 salt = keccak256("salt-1");
        (uint8 v, bytes32 r, bytes32 s) = _sign(merchant, mv, fv, salt);

        bytes32 expectedNonce = _commitNonce(merchant, mv, fv, salt);
        vm.expectEmit(true, true, true, true);
        emit Eip3009Forwarder.Settled(customer, expectedNonce, merchant, mv, feeReceiver, fv);

        forwarder.settle(customer, merchant, mv, fv, validAfter, validBefore, salt, v, r, s);

        assertEq(token.balanceOf(merchant), mv, "merchant gets full amount");
        assertEq(token.balanceOf(feeReceiver), fv, "feeReceiver gets gas-equivalent");
        assertEq(token.balanceOf(customer), 1_000_000 ether - mv - fv, "customer pays total");
    }

    function test_settle_merchantMode_splitsCorrectly() public {
        // 店主吸収: 顧客は請求額(1000)のみ。店舗受取 = 1000-3、OpenPay が 3 を回収。
        uint256 amount = 1000 ether;
        uint256 fv = 3 ether;
        uint256 mv = amount - fv;
        bytes32 salt = keccak256("salt-merchant");
        (uint8 v, bytes32 r, bytes32 s) = _sign(merchant, mv, fv, salt);

        forwarder.settle(customer, merchant, mv, fv, validAfter, validBefore, salt, v, r, s);

        assertEq(token.balanceOf(merchant), mv, "merchant absorbs gas");
        assertEq(token.balanceOf(feeReceiver), fv);
        assertEq(token.balanceOf(customer), 1_000_000 ether - amount, "customer pays only amount");
    }

    // --- tamper / commitment ---------------------------------------------

    function test_settle_revertsOnSplitTamper_sameTotal() public {
        // 顧客は (1000, 3) に署名。relayer が (900, 103) に改竄 (total は同じ 1003)。
        // 再計算 nonce が顧客署名と食い違い、token の署名検証で revert する。
        uint256 mv = 1000 ether;
        uint256 fv = 3 ether;
        bytes32 salt = keccak256("salt-tamper");
        (uint8 v, bytes32 r, bytes32 s) = _sign(merchant, mv, fv, salt);

        vm.expectRevert(MockEip3009Token.InvalidSignature.selector);
        forwarder.settle(
            customer, merchant, 900 ether, 103 ether, validAfter, validBefore, salt, v, r, s
        );
    }

    function test_settle_revertsOnFeeReceiverRedirect() public {
        // 署名は本来の feeReceiver(commit に含む) で作られる。settle 自体は immutable feeReceiver を
        // 使うので回収先は固定だが、merchant を別アドレスに差し替えると nonce 不一致で revert。
        uint256 mv = 1000 ether;
        uint256 fv = 3 ether;
        bytes32 salt = keccak256("salt-redirect");
        (uint8 v, bytes32 r, bytes32 s) = _sign(merchant, mv, fv, salt);

        vm.expectRevert(MockEip3009Token.InvalidSignature.selector);
        forwarder.settle(customer, address(0xCAFE), mv, fv, validAfter, validBefore, salt, v, r, s);
    }

    // --- intentSalt 一意性 / replay --------------------------------------

    function test_settle_sameParamsDifferentSalt_bothSucceed() public {
        uint256 mv = 100 ether;
        uint256 fv = 1 ether;
        (uint8 v1, bytes32 r1, bytes32 s1) = _sign(merchant, mv, fv, keccak256("s-a"));
        (uint8 v2, bytes32 r2, bytes32 s2) = _sign(merchant, mv, fv, keccak256("s-b"));

        forwarder.settle(
            customer, merchant, mv, fv, validAfter, validBefore, keccak256("s-a"), v1, r1, s1
        );
        forwarder.settle(
            customer, merchant, mv, fv, validAfter, validBefore, keccak256("s-b"), v2, r2, s2
        );

        assertEq(token.balanceOf(merchant), mv * 2, "both succeed (no nonce collision)");
    }

    function test_settle_replaySameSaltReverts() public {
        uint256 mv = 100 ether;
        uint256 fv = 1 ether;
        bytes32 salt = keccak256("s-replay");
        (uint8 v, bytes32 r, bytes32 s) = _sign(merchant, mv, fv, salt);

        forwarder.settle(customer, merchant, mv, fv, validAfter, validBefore, salt, v, r, s);
        vm.expectRevert(MockEip3009Token.AuthUsed.selector);
        forwarder.settle(customer, merchant, mv, fv, validAfter, validBefore, salt, v, r, s);
    }

    // --- guards -----------------------------------------------------------

    function test_settle_revertsZeroFeeValue() public {
        uint256 mv = 1000 ether;
        (uint8 v, bytes32 r, bytes32 s) = _sign(merchant, mv, 0, keccak256("z"));
        vm.expectRevert(Eip3009Forwarder.ZeroValue.selector);
        forwarder.settle(
            customer, merchant, mv, 0, validAfter, validBefore, keccak256("z"), v, r, s
        );
    }

    function test_settle_revertsZeroMerchant() public {
        (uint8 v, bytes32 r, bytes32 s) = _sign(address(0), 1000 ether, 3 ether, keccak256("zm"));
        vm.expectRevert(Eip3009Forwarder.ZeroAddress.selector);
        forwarder.settle(
            customer,
            address(0),
            1000 ether,
            3 ether,
            validAfter,
            validBefore,
            keccak256("zm"),
            v,
            r,
            s
        );
    }

    function test_settle_revertsMerchantIsFeeReceiver() public {
        uint256 mv = 1000 ether;
        uint256 fv = 3 ether;
        (uint8 v, bytes32 r, bytes32 s) = _sign(feeReceiver, mv, fv, keccak256("mf"));
        vm.expectRevert(Eip3009Forwarder.MerchantIsFeeReceiver.selector);
        forwarder.settle(
            customer, feeReceiver, mv, fv, validAfter, validBefore, keccak256("mf"), v, r, s
        );
    }

    // --- SafeERC20 (false 返り値) -----------------------------------------

    function test_settle_revertsOnTransferReturningFalse() public {
        token.setTransferReturnsFalse(true);
        uint256 mv = 1000 ether;
        uint256 fv = 3 ether;
        bytes32 salt = keccak256("sft");
        (uint8 v, bytes32 r, bytes32 s) = _sign(merchant, mv, fv, salt);
        bytes32 nonce = _commitNonce(merchant, mv, fv, salt);
        // receive は成功して forwarder に着金するが、safeTransfer が false を弾いて全 revert。
        vm.expectRevert();
        forwarder.settle(customer, merchant, mv, fv, validAfter, validBefore, salt, v, r, s);
        // 全 revert を確認: 残高変化なし + authorization 未消費 (= 再試行可能)。
        assertEq(token.balanceOf(merchant), 0, "merchant unchanged");
        assertEq(token.balanceOf(feeReceiver), 0, "feeReceiver unchanged");
        assertEq(token.balanceOf(customer), 1_000_000 ether, "customer unchanged");
        assertFalse(token.authorizationState(customer, nonce), "nonce not consumed");
    }

    // --- 追加 guards / token プロパティ (Codex code-review 反映) -----------

    function test_settle_revertsZeroSalt() public {
        uint256 mv = 1000 ether;
        uint256 fv = 3 ether;
        (uint8 v, bytes32 r, bytes32 s) = _sign(merchant, mv, fv, bytes32(0));
        vm.expectRevert(Eip3009Forwarder.ZeroSalt.selector);
        forwarder.settle(customer, merchant, mv, fv, validAfter, validBefore, bytes32(0), v, r, s);
    }

    function test_settle_revertsWhenExpired() public {
        validBefore = block.timestamp + 10;
        uint256 mv = 1000 ether;
        uint256 fv = 3 ether;
        bytes32 salt = keccak256("exp");
        (uint8 v, bytes32 r, bytes32 s) = _sign(merchant, mv, fv, salt);
        vm.warp(block.timestamp + 20); // validBefore を過ぎる
        vm.expectRevert(MockEip3009Token.Expired.selector);
        forwarder.settle(customer, merchant, mv, fv, validAfter, validBefore, salt, v, r, s);
    }

    // golden vector: 固定入力で nonce を計算してログ出力。TS (forwarderIntent) の
    // buildForwarderNonce が同値になることを tests/lib/forwarderIntent.test.ts で照合する
    // (Solidity の abi.encode と TS の encodeAbiParameters の一致を fence)。
    function test_goldenVector_nonce() public view {
        assertEq(
            forwarder.COMMIT_VERSION(),
            keccak256("openpay.eip3009.forwarder.v1"),
            "COMMIT_VERSION must match the shared TS constant"
        );
        bytes32 nonce = keccak256(
            abi.encode(
                forwarder.COMMIT_VERSION(),
                address(0x1111111111111111111111111111111111111111), // from
                address(0x2222222222222222222222222222222222222222), // merchant
                uint256(1000e18), // merchantValue
                address(0x3333333333333333333333333333333333333333), // feeReceiver
                uint256(2e18), // feeValue
                uint256(0), // validAfter
                uint256(1_000_000_000_000), // validBefore
                bytes32(0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef), // salt
                uint256(80002), // chainId (Amoy)
                address(0x4444444444444444444444444444444444444444) // forwarder
            )
        );
        console2.logBytes32(nonce);
    }

    // forwarder が依存する token の payee ガード (msg.sender==to) を直接確認。
    function test_token_receiveWithAuthorization_rejectsNonPayee() public {
        uint256 mv = 100 ether;
        uint256 fv = 1 ether;
        bytes32 salt = keccak256("payee");
        (uint8 v, bytes32 r, bytes32 s) = _sign(merchant, mv, fv, salt);
        bytes32 nonce = _commitNonce(merchant, mv, fv, salt);
        // 呼び出し元 (この test 契約) != to (forwarder) → CallerNotPayee。
        vm.expectRevert(MockEip3009Token.CallerNotPayee.selector);
        token.receiveWithAuthorization(
            customer, address(forwarder), mv + fv, validAfter, validBefore, nonce, v, r, s
        );
    }
}
