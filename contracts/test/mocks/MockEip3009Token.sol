// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @dev テスト用の最小 FiatToken 風 EIP-3009 トークン。`receiveWithAuthorization` の payee
///   ガード + EIP-712 署名検証 + nonce 使用済管理を実装し、JPYC の挙動を再現する。
///   `setTransferReturnsFalse(true)` で transfer が false を返す ERC20 違反を再現し、
///   forwarder の SafeERC20 ガードを検証できる。
contract MockEip3009Token {
    string public constant name = "JPY Coin";
    string public constant version = "1";
    uint8 public constant decimals = 18;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(bytes32 => bool)) public authorizationState;

    bool public transferReturnsFalse;

    bytes32 private constant EIP712_DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );
    bytes32 private constant RECEIVE_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    error AuthUsed();
    error NotYetValid();
    error Expired();
    error CallerNotPayee();
    error InvalidSignature();
    error InsufficientBalance();

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function setTransferReturnsFalse(bool v) external {
        transferReturnsFalse = v;
    }

    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH,
                keccak256(bytes(name)),
                keccak256(bytes(version)),
                block.chainid,
                address(this)
            )
        );
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        if (transferReturnsFalse) return false; // ERC20 違反 (false) → SafeERC20 が弾くか検証
        _transfer(msg.sender, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) internal {
        if (balanceOf[from] < amount) revert InsufficientBalance();
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
    }

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
    ) external {
        if (msg.sender != to) revert CallerNotPayee();
        if (block.timestamp <= validAfter) revert NotYetValid();
        if (block.timestamp >= validBefore) revert Expired();
        if (authorizationState[from][nonce]) revert AuthUsed();
        bytes32 structHash = keccak256(
            abi.encode(
                RECEIVE_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR(), structHash));
        address signer = ecrecover(digest, v, r, s);
        if (signer == address(0) || signer != from) revert InvalidSignature();
        authorizationState[from][nonce] = true;
        _transfer(from, to, value);
    }
}
