// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import {
    ERC1155URIStorage
} from "@openzeppelin/contracts/token/ERC1155/extensions/ERC1155URIStorage.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @title OpenPayLicense1155
/// @notice Store 商品の利用ライセンス証明。商品ごとに lifetime cap・譲渡可否・定義 hash を固定する。
///   owner (cold) は minter (hot) と別アドレス。minter の交代/停止と metadata 修復は owner が行う。
///   決済や利用回数/残高は扱わない。paymentKey の決済証拠確認は minter の責務。
/// @dev Checks-effects-interactions: consumed/minted と ERC1155 balance は receiver callback 前に確定。
///   再入しても同一 key の消費や lifetime cap 超過は不可。別 key の mint は onlyMinter に従い、
///   burn も lifetime 状態を戻さないため ReentrancyGuard は不要。receiver revert は全状態を戻す。
contract OpenPayLicense1155 is ERC1155, ERC1155URIStorage, Ownable2Step {
    /// @notice 1 商品の lifetime 発行上限 (商品ポリシー・burn で補充しない)。
    uint64 public constant MAX_SUPPLY_CAP = 10_000;
    /// @notice 決済 identity の ABI schema version。txHash はこの key に含めない。
    bytes32 public constant PAYMENT_KEY_V1 = keccak256("openpay.license.payment.v1");

    struct License {
        uint64 maxSupply;
        uint64 minted;
        bool transferable;
        bool exists;
        bytes32 definitionHash;
    }

    struct MintRecord {
        uint256 id;
        address to;
    }

    /// @notice 登録/mint の単一権限。address(0) は無効化。
    address public minter;
    mapping(uint256 id => License) private licenses;
    // to != 0 が消費済みの sentinel。id=0 / paymentKey=0 も通常どおり記録できる。
    mapping(bytes32 paymentKey => MintRecord) private consumed;

    event MinterUpdated(address indexed previousMinter, address indexed newMinter);
    event LicenseRegistered(
        uint256 indexed id, uint64 maxSupply, bool transferable, bytes32 definitionHash
    );
    event LicenseMinted(uint256 indexed id, address indexed to, bytes32 indexed paymentKey);

    error UnauthorizedMinter(address account);
    error OwnerIsMinter();
    error InvalidMaxSupply(uint64 maxSupply);
    error DefinitionMismatch(uint256 id);
    error ZeroRecipient();
    error UnknownLicense(uint256 id);
    error SupplyCapReached(uint256 id);
    error PaymentKeyConsumed(bytes32 paymentKey);
    error Soulbound(uint256 id);
    error RenounceOwnershipDisabled();

    constructor(address initialOwner, address initialMinter) ERC1155("") Ownable(initialOwner) {
        _setMinter(initialMinter);
    }

    modifier onlyMinter() {
        if (minter == address(0) || _msgSender() != minter) {
            revert UnauthorizedMinter(_msgSender());
        }
        _;
    }

    /// @notice hot minter を交代する。address(0) で登録/mint を停止 (既発行分は残る)。
    function setMinter(address newMinter) external onlyOwner {
        _setMinter(newMinter);
    }

    function _setMinter(address newMinter) private {
        if (newMinter == owner()) revert OwnerIsMinter();
        address previousMinter = minter;
        minter = newMinter;
        emit MinterUpdated(previousMinter, newMinter);
    }

    /// @notice 商品定義を一度だけ登録する。同一 definitionHash の retry は完全な no-op。
    /// @dev definitionHash の生成/引数との対応は minter の責務。一致時は他の引数を再適用せず、
    ///   owner が修復した URI・発行済み数・登録時の supply/譲渡可否も保持する。
    function registerLicense(
        uint256 id,
        uint64 maxSupply,
        bool transferable,
        string calldata tokenURI,
        bytes32 definitionHash
    ) external onlyMinter {
        License storage license = licenses[id];
        if (license.exists) {
            if (license.definitionHash != definitionHash) revert DefinitionMismatch(id);
            return;
        }
        if (maxSupply == 0 || maxSupply > MAX_SUPPLY_CAP) revert InvalidMaxSupply(maxSupply);
        licenses[id] = License(maxSupply, 0, transferable, true, definitionHash);
        _setURI(id, tokenURI);
        emit LicenseRegistered(id, maxSupply, transferable, definitionHash);
    }

    /// @notice 確認済みの決済 identity につき 1 枚を発行する。受取不能なら全体 revert。
    /// @param to 検証済み payer。ゼロアドレスは禁止。
    /// @param id 登録済み tokenId。
    /// @param paymentKey computePaymentKey で求める決済 identity (全 id 共通の消費記録)。
    function mintFor(address to, uint256 id, bytes32 paymentKey) external onlyMinter {
        if (to == address(0)) revert ZeroRecipient();
        License storage license = licenses[id];
        if (!license.exists) revert UnknownLicense(id);
        if (consumed[paymentKey].to != address(0)) revert PaymentKeyConsumed(paymentKey);
        if (license.minted >= license.maxSupply) revert SupplyCapReached(id);

        // 外部 receiver に制御を渡す前に両不変条件を完成させる (safe-mint callback 対策)。
        consumed[paymentKey] = MintRecord(id, to);
        license.minted++;
        _mint(to, id, 1, "");
        emit LicenseMinted(id, to, paymentKey);
    }

    /// @notice 自分の証明のみ burn する。approval を受けた operator は他人の分を burn できない。
    /// @dev minted / consumed は lifetime 記録なので減らさない。
    function burn(uint256 id, uint256 amount) external {
        _burn(_msgSender(), id, amount);
    }

    /// @notice 自分の証明のみ一括 burn。1 件でも残高不足なら全体 revert。
    function burnBatch(uint256[] calldata ids, uint256[] calldata amounts) external {
        _burnBatch(_msgSender(), ids, amounts);
    }

    /// @notice 登録済み商品の metadata URI を修復する。定義 hash・供給・譲渡可否は不変。
    function setURI(uint256 id, string calldata tokenURI) external onlyOwner {
        if (!licenses[id].exists) revert UnknownLicense(id);
        _setURI(id, tokenURI);
    }

    /// @notice token ごとの URI (ERC1155URIStorage) を返す。
    function uri(uint256 id)
        public
        view
        override(ERC1155, ERC1155URIStorage)
        returns (string memory)
    {
        return super.uri(id);
    }

    /// @notice 不変の商品定義と lifetime 発行数。未登録は exists=false。
    function licenseOf(uint256 id) external view returns (License memory) {
        return licenses[id];
    }

    /// @notice 決済 identity の発行記録。未消費は to=address(0) (id=0 だけでは判定しない)。
    function paymentKeyOf(bytes32 paymentKey) external view returns (MintRecord memory) {
        return consumed[paymentKey];
    }

    /// @notice ABI encode (packed 不可) で payment authorization を一意化する。
    /// @dev paymentChainId は決済元 chain。NFT chain / contract / id / txHash は含めない。
    function computePaymentKey(
        uint256 paymentChainId,
        address paymentToken,
        address payer,
        bytes32 authorizationNonce
    ) public pure returns (bytes32) {
        return keccak256(
            abi.encode(PAYMENT_KEY_V1, paymentChainId, paymentToken, payer, authorizationNonce)
        );
    }

    /// @notice hosted product id の UTF-8 文字列全体から uint256 tokenId を求める。
    /// @dev hostedStore.newHostedId(): "h_" + 小文字 hex 32 桁 (ランダム 128 bit)。
    ///   "h_" を除去/hex decode/正規化しない。固定 prefix + 単一可変長文字列なので境界は一意。
    ///   この pure helper は形式検証しない。外部 identity は chain + contract + tokenId。
    function computeTokenId(string calldata productId) public pure returns (uint256) {
        return uint256(keccak256(abi.encodePacked("openpay:license:", productId)));
    }

    /// @notice repair 権限を失わせないため ownership 放棄は禁止。
    function renounceOwnership() public view override onlyOwner {
        revert RenounceOwnershipDisabled();
    }

    /// @dev 2 段階移転の acceptance 時にも owner と minter の分離を維持する。
    function _transferOwnership(address newOwner) internal override {
        if (newOwner == minter) revert OwnerIsMinter();
        super._transferOwnership(newOwner);
    }

    /// @dev mint/burn 以外は全 id の譲渡許可が必要。自己送信・0 量・混在 batch・operator も同じ。
    function _update(address from, address to, uint256[] memory ids, uint256[] memory values)
        internal
        override
    {
        if (from != address(0) && to != address(0)) {
            for (uint256 i = 0; i < ids.length; ++i) {
                if (!licenses[ids[i]].transferable) revert Soulbound(ids[i]);
            }
        }
        super._update(from, to, ids, values);
    }
}
