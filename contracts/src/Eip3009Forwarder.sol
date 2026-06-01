// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @dev EIP-3009 の receiveWithAuthorization のみ (JPYC = FiatToken 系が実装)。
interface IERC3009 {
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;
}

/// @title Eip3009Forwarder
/// @notice JPYC ガスレス決済 (OpenPay) のガス相当額回収用 forwarder。
///   顧客の 1 署名 (EIP-3009 `receiveWithAuthorization`) で JPYC を本コントラクトが受領し、
///   店舗 (`merchant`) と `feeReceiver` (= OpenPay のガス立替回収先) にアトミックに分割送金する。
///   relayer (OpenPay の EOA) が POL ガスを立替えて `settle` を呼び、gas 相当額 (`feeValue`) を
///   JPYC で回収する。日本法配慮: OpenPay は gas を負担せず立替→即時回収 (memory:gasless-legal-jp)。
///
/// @dev 改竄防止: 分割先・額は EIP-3009 の `nonce` に commit されている
///   (`nonce = keccak256(COMMIT_VERSION, from, merchant, merchantValue, feeReceiver, feeValue,
///    validAfter, validBefore, intentSalt, chainid, this)`)。relayer が split を改竄すると
///   再計算 nonce が顧客署名の nonce と食い違い、token の署名検証で revert する (別途 require 不要)。
///   `receiveWithAuthorization` は msg.sender==to を強制するため payee ガード (フロントラン防止) が効く。
///   immutable・owner/upgrade 無し・正常 settle 後は残高ゼロ (受領→分割が 1 tx アトミック・全 revert)。
///   誤って直接送られた JPYC は設計上回収不能 (rescue 機能なし = 信頼前提を最小化)。
contract Eip3009Forwarder is ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice commit schema の version。将来 schema を変える際に旧署名を弾くための prefix。
    bytes32 public constant COMMIT_VERSION = keccak256("openpay.eip3009.forwarder.v1");

    /// @notice 決済トークン (JPYC・FiatToken 系・EIP-3009)。
    IERC20 public immutable token;
    /// @notice ガス立替の回収先 (OpenPay)。immutable。変更は新 forwarder を deploy。
    address public immutable feeReceiver;

    event Settled(
        address indexed from,
        bytes32 indexed nonce,
        address indexed merchant,
        uint256 merchantValue,
        address feeReceiver,
        uint256 feeValue
    );

    error ZeroAddress();
    error ZeroValue();
    error MerchantIsFeeReceiver();

    constructor(IERC20 token_, address feeReceiver_) {
        if (address(token_) == address(0) || feeReceiver_ == address(0)) {
            revert ZeroAddress();
        }
        token = token_;
        feeReceiver = feeReceiver_;
    }

    /// @notice 顧客署名どおりに JPYC を受領し、店舗と feeReceiver に分割送金する。
    ///   誰でも呼べる (relayer 想定) が、`receiveWithAuthorization` の payee ガードと nonce-commit に
    ///   より「顧客が署名した分割」しか実行できない (funds-safe)。
    /// @param from         支払元 (顧客)。
    /// @param merchant     店舗 (gasMode=customer: 全額 / merchant: amount−gasEquiv)。
    /// @param merchantValue 店舗受取額。
    /// @param feeValue     ガス相当額 (= OpenPay 回収分)。
    /// @param validAfter   EIP-3009 有効開始 (unix sec)。
    /// @param validBefore  EIP-3009 有効期限 (unix sec)。
    /// @param intentSalt   毎回ランダムな 32B (同一内容の決済でも nonce を一意化)。
    /// @param v,r,s        顧客の EIP-3009 receiveWithAuthorization 署名。
    function settle(
        address from,
        address merchant,
        uint256 merchantValue,
        uint256 feeValue,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 intentSalt,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant {
        if (from == address(0) || merchant == address(0)) revert ZeroAddress();
        if (merchantValue == 0 || feeValue == 0) revert ZeroValue();
        // 店舗 == 回収先 は会計が崩れる (店舗が自分のガスを回収する形) ため明示禁止。
        if (merchant == feeReceiver) revert MerchantIsFeeReceiver();

        // total は overflow チェック付き加算 (solc 0.8)。
        uint256 value = merchantValue + feeValue;

        // 分割を nonce に束縛。relayer が split を改竄すると nonce が顧客署名と食い違い、
        // 下の receiveWithAuthorization の署名検証 (signer==from) で revert する。
        bytes32 nonce = keccak256(
            abi.encode(
                COMMIT_VERSION,
                from,
                merchant,
                merchantValue,
                feeReceiver,
                feeValue,
                validAfter,
                validBefore,
                intentSalt,
                block.chainid,
                address(this)
            )
        );

        // 受領 (msg.sender == to == address(this) を token が強制 = payee ガード)。
        // value / validAfter / validBefore / nonce / 署名 が一致しなければ token 側で revert。
        IERC3009(address(token))
            .receiveWithAuthorization(
                from, address(this), value, validAfter, validBefore, nonce, v, r, s
            );

        // 分割送金。SafeERC20 で false 返り値も revert 扱い。いずれか失敗で全 revert = 資金非保持。
        token.safeTransfer(merchant, merchantValue);
        token.safeTransfer(feeReceiver, feeValue);

        emit Settled(from, nonce, merchant, merchantValue, feeReceiver, feeValue);
    }
}
