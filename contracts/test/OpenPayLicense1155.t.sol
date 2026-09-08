// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC1155Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {ERC1155Holder} from "@openzeppelin/contracts/token/ERC1155/utils/ERC1155Holder.sol";
import {OpenPayLicense1155} from "../src/OpenPayLicense1155.sol";

contract AcceptingLicenseReceiver is ERC1155Holder {}

contract RejectingLicenseReceiver is ERC1155Holder {
    function onERC1155Received(address, address, uint256, uint256, bytes memory)
        public
        pure
        override
        returns (bytes4)
    {
        return bytes4(0);
    }
}

/// @dev minter 自身を receiver にした強い再入条件も検証。外側の不変条件を callback 内で観測。
contract ReentrantLicenseReceiver is ERC1155Holder {
    bytes32 public constant PAYMENT_KEY = keccak256("receiver-payment");
    bytes32 public constant FRESH_KEY = keccak256("receiver-fresh-payment");
    address public constant OTHER_RECIPIENT = address(0xB0B);
    OpenPayLicense1155 private immutable license;
    bool private immutable burnFirst;
    bool private immutable rejectAfter;
    bool public observed;
    bool public replaySucceeded;
    bool public freshSucceeded;
    bytes public replayResult;
    bytes public freshResult;

    error CallbackInvariantsMissing();
    error ReceiverRejected();

    constructor(OpenPayLicense1155 license_, bool burnFirst_, bool rejectAfter_) {
        license = license_;
        burnFirst = burnFirst_;
        rejectAfter = rejectAfter_;
    }

    function onERC1155Received(address, address, uint256 id, uint256, bytes memory)
        public
        override
        returns (bytes4)
    {
        if (observed) return this.onERC1155Received.selector;
        OpenPayLicense1155.MintRecord memory record = license.paymentKeyOf(PAYMENT_KEY);
        if (
            record.id != id || record.to != address(this) || license.licenseOf(id).minted != 1
                || license.balanceOf(address(this), id) != 1
        ) revert CallbackInvariantsMissing();
        observed = true;
        if (burnFirst) license.burn(id, 1);
        (replaySucceeded, replayResult) = address(license)
            .call(abi.encodeCall(license.mintFor, (address(this), id, PAYMENT_KEY)));
        (freshSucceeded, freshResult) = address(license)
            .call(abi.encodeCall(license.mintFor, (OTHER_RECIPIENT, id, FRESH_KEY)));
        if (rejectAfter) revert ReceiverRejected();
        return this.onERC1155Received.selector;
    }
}

contract OpenPayLicense1155Test is Test {
    OpenPayLicense1155 internal license;
    address internal owner = address(0xC01D);
    address internal minter = address(0xA11CE);
    address internal holder = address(0xBEEF);
    address internal recipient = address(0xCAFE);
    address internal operator = address(0xD00D);
    uint256 internal constant SOULBOUND_ID = 1;
    uint256 internal constant TRANSFERABLE_ID = 2;
    bytes32 internal constant DEFINITION = keccak256("definition-v1");
    bytes32 internal constant KEY = keccak256("payment-1");
    bytes32 internal constant KEY_2 = keccak256("payment-2");

    function setUp() public {
        license = new OpenPayLicense1155(owner, minter);
    }

    function _register(uint256 id, uint64 maxSupply, bool transferable) internal {
        vm.prank(minter);
        license.registerLicense(id, maxSupply, transferable, "ipfs://license", DEFINITION);
    }

    function _mint(address to, uint256 id, bytes32 key) internal {
        vm.prank(minter);
        license.mintFor(to, id, key);
    }

    function _heldLicenses() internal {
        _register(SOULBOUND_ID, 2, false);
        _register(TRANSFERABLE_ID, 2, true);
        _mint(holder, SOULBOUND_ID, KEY);
        _mint(holder, TRANSFERABLE_ID, KEY_2);
    }

    function _pair(uint256 first, uint256 second) internal pure returns (uint256[] memory values) {
        values = new uint256[](2);
        values[0] = first;
        values[1] = second;
    }

    function _assertRecord(bytes32 key, uint256 id, address to) internal view {
        OpenPayLicense1155.MintRecord memory record = license.paymentKeyOf(key);
        assertEq(record.id, id);
        assertEq(record.to, to);
    }

    // --- registration / lifetime supply ----------------------------------

    function test_registrationStoresDefinitionAndEmits() public {
        vm.expectEmit(true, false, false, true, address(license));
        emit OpenPayLicense1155.LicenseRegistered(SOULBOUND_ID, 2, false, DEFINITION);
        _register(SOULBOUND_ID, 2, false);
        OpenPayLicense1155.License memory info = license.licenseOf(SOULBOUND_ID);
        assertTrue(info.exists);
        assertEq(info.maxSupply, 2);
        assertEq(info.minted, 0);
        assertFalse(info.transferable);
        assertEq(info.definitionHash, DEFINITION);
        assertEq(license.uri(SOULBOUND_ID), "ipfs://license");
    }

    function test_registrationRetryIsNoOpAfterMintAndURIRepair() public {
        _register(SOULBOUND_ID, 2, false);
        _mint(holder, SOULBOUND_ID, KEY);
        vm.prank(owner);
        license.setURI(SOULBOUND_ID, "ipfs://repaired");
        vm.recordLogs();
        vm.prank(minter);
        license.registerLicense(SOULBOUND_ID, 0, true, "ipfs://different", DEFINITION);
        assertEq(vm.getRecordedLogs().length, 0);
        OpenPayLicense1155.License memory info = license.licenseOf(SOULBOUND_ID);
        assertEq(info.maxSupply, 2);
        assertEq(info.minted, 1);
        assertFalse(info.transferable);
        assertEq(info.definitionHash, DEFINITION);
        assertEq(license.uri(SOULBOUND_ID), "ipfs://repaired");
    }

    function test_registrationDefinitionMismatchReverts() public {
        _register(SOULBOUND_ID, 2, false);
        vm.expectRevert(
            abi.encodeWithSelector(OpenPayLicense1155.DefinitionMismatch.selector, SOULBOUND_ID)
        );
        vm.prank(minter);
        license.registerLicense(SOULBOUND_ID, 2, false, "ipfs://license", keccak256("other"));
        assertEq(license.licenseOf(SOULBOUND_ID).definitionHash, DEFINITION);
    }

    function test_registrationCapBounds() public {
        vm.expectRevert(
            abi.encodeWithSelector(OpenPayLicense1155.InvalidMaxSupply.selector, uint64(0))
        );
        _register(1, 0, false);
        vm.expectRevert(
            abi.encodeWithSelector(OpenPayLicense1155.InvalidMaxSupply.selector, uint64(10_001))
        );
        _register(1, 10_001, false);
        assertFalse(license.licenseOf(1).exists);
        _register(1, 1, false);
        _register(2, 10_000, true);
        assertEq(license.licenseOf(1).maxSupply, 1);
        assertEq(license.licenseOf(2).maxSupply, 10_000);
        assertEq(license.MAX_SUPPLY_CAP(), 10_000);
    }

    function testFuzz_registrationRejectsAboveCap(uint64 supply) public {
        supply = uint64(bound(supply, 10_001, type(uint64).max));
        vm.expectRevert(
            abi.encodeWithSelector(OpenPayLicense1155.InvalidMaxSupply.selector, supply)
        );
        _register(1, supply, false);
    }

    function test_mintRecordsIdentityAndEmits() public {
        _register(SOULBOUND_ID, 1, false);
        vm.expectEmit(true, true, true, true, address(license));
        emit OpenPayLicense1155.LicenseMinted(SOULBOUND_ID, holder, KEY);
        _mint(holder, SOULBOUND_ID, KEY);
        assertEq(license.balanceOf(holder, SOULBOUND_ID), 1);
        assertEq(license.licenseOf(SOULBOUND_ID).minted, 1);
        _assertRecord(KEY, SOULBOUND_ID, holder);
    }

    function test_mintCapRevertsWithoutConsumingKey() public {
        _register(SOULBOUND_ID, 1, false);
        _mint(holder, SOULBOUND_ID, KEY);
        vm.expectRevert(
            abi.encodeWithSelector(OpenPayLicense1155.SupplyCapReached.selector, SOULBOUND_ID)
        );
        _mint(recipient, SOULBOUND_ID, KEY_2);
        _assertRecord(KEY_2, 0, address(0));
        assertEq(license.licenseOf(SOULBOUND_ID).minted, 1);
        assertEq(license.balanceOf(recipient, SOULBOUND_ID), 0);
    }

    function test_duplicatePaymentKeyCannotChangeIdOrRecipient() public {
        _register(SOULBOUND_ID, 2, false);
        _register(TRANSFERABLE_ID, 2, true);
        _mint(holder, SOULBOUND_ID, KEY);
        vm.expectRevert(abi.encodeWithSelector(OpenPayLicense1155.PaymentKeyConsumed.selector, KEY));
        _mint(holder, SOULBOUND_ID, KEY);
        vm.expectRevert(abi.encodeWithSelector(OpenPayLicense1155.PaymentKeyConsumed.selector, KEY));
        _mint(recipient, TRANSFERABLE_ID, KEY);
        _assertRecord(KEY, SOULBOUND_ID, holder);
        assertEq(license.licenseOf(SOULBOUND_ID).minted, 1);
        assertEq(license.licenseOf(TRANSFERABLE_ID).minted, 0);
    }

    function test_mintZeroRecipientAndUnknownIdRevert() public {
        _register(SOULBOUND_ID, 1, false);
        vm.expectRevert(OpenPayLicense1155.ZeroRecipient.selector);
        _mint(address(0), SOULBOUND_ID, KEY);
        vm.expectRevert(
            abi.encodeWithSelector(OpenPayLicense1155.UnknownLicense.selector, uint256(99))
        );
        _mint(holder, 99, KEY);
        _assertRecord(KEY, 0, address(0));
        assertEq(license.licenseOf(SOULBOUND_ID).minted, 0);
        assertFalse(license.licenseOf(99).exists);
    }

    function test_zeroIdKeyAndDefinitionAreNotMissingSentinels() public {
        vm.prank(minter);
        license.registerLicense(0, 2, false, "", bytes32(0));
        _mint(holder, 0, bytes32(0));
        _assertRecord(bytes32(0), 0, holder);
        assertTrue(license.licenseOf(0).exists);
        vm.expectRevert(
            abi.encodeWithSelector(OpenPayLicense1155.PaymentKeyConsumed.selector, bytes32(0))
        );
        _mint(recipient, 0, bytes32(0));
    }

    // --- soulbound: all nonzero -> nonzero paths --------------------------

    function test_soulboundSingleTransferReverts() public {
        _heldLicenses();
        vm.expectRevert(abi.encodeWithSelector(OpenPayLicense1155.Soulbound.selector, SOULBOUND_ID));
        vm.prank(holder);
        license.safeTransferFrom(holder, recipient, SOULBOUND_ID, 1, "");
        assertEq(license.balanceOf(holder, SOULBOUND_ID), 1);
    }

    function test_soulboundSelfTransferReverts() public {
        _heldLicenses();
        vm.expectRevert(abi.encodeWithSelector(OpenPayLicense1155.Soulbound.selector, SOULBOUND_ID));
        vm.prank(holder);
        license.safeTransferFrom(holder, holder, SOULBOUND_ID, 1, "");
    }

    function test_soulboundZeroAmountRevertsEvenWithoutBalance() public {
        _register(SOULBOUND_ID, 1, false);
        vm.expectRevert(abi.encodeWithSelector(OpenPayLicense1155.Soulbound.selector, SOULBOUND_ID));
        vm.prank(holder);
        license.safeTransferFrom(holder, recipient, SOULBOUND_ID, 0, "");
    }

    function test_soulboundBatchReverts() public {
        _heldLicenses();
        _register(3, 1, false);
        _mint(holder, 3, keccak256("third"));
        vm.expectRevert(abi.encodeWithSelector(OpenPayLicense1155.Soulbound.selector, SOULBOUND_ID));
        vm.prank(holder);
        license.safeBatchTransferFrom(holder, recipient, _pair(SOULBOUND_ID, 3), _pair(1, 1), "");
    }

    function test_soulboundMixedBatchRevertsAtomically() public {
        _heldLicenses();
        vm.expectRevert(abi.encodeWithSelector(OpenPayLicense1155.Soulbound.selector, SOULBOUND_ID));
        vm.prank(holder);
        license.safeBatchTransferFrom(
            holder, recipient, _pair(TRANSFERABLE_ID, SOULBOUND_ID), _pair(1, 1), ""
        );
        assertEq(license.balanceOf(holder, TRANSFERABLE_ID), 1);
        assertEq(license.balanceOf(holder, SOULBOUND_ID), 1);
        assertEq(license.balanceOf(recipient, TRANSFERABLE_ID), 0);
    }

    function test_soulboundZeroAmountInMixedBatchReverts() public {
        _heldLicenses();
        vm.expectRevert(abi.encodeWithSelector(OpenPayLicense1155.Soulbound.selector, SOULBOUND_ID));
        vm.prank(holder);
        license.safeBatchTransferFrom(
            holder, recipient, _pair(TRANSFERABLE_ID, SOULBOUND_ID), _pair(1, 0), ""
        );
        assertEq(license.balanceOf(holder, TRANSFERABLE_ID), 1);
    }

    function test_soulboundDuplicateIdSelfBatchReverts() public {
        _heldLicenses();
        vm.expectRevert(abi.encodeWithSelector(OpenPayLicense1155.Soulbound.selector, SOULBOUND_ID));
        vm.prank(holder);
        license.safeBatchTransferFrom(
            holder, holder, _pair(SOULBOUND_ID, SOULBOUND_ID), _pair(0, 0), ""
        );
    }

    function test_approvalCannotBypassSoulboundSingleOrBatch() public {
        _heldLicenses();
        vm.prank(holder);
        license.setApprovalForAll(operator, true);
        assertTrue(license.isApprovedForAll(holder, operator));
        vm.startPrank(operator);
        vm.expectRevert(abi.encodeWithSelector(OpenPayLicense1155.Soulbound.selector, SOULBOUND_ID));
        license.safeTransferFrom(holder, recipient, SOULBOUND_ID, 1, "");
        vm.expectRevert(abi.encodeWithSelector(OpenPayLicense1155.Soulbound.selector, SOULBOUND_ID));
        license.safeBatchTransferFrom(
            holder, recipient, _pair(TRANSFERABLE_ID, SOULBOUND_ID), _pair(1, 1), ""
        );
        vm.stopPrank();
        assertEq(license.balanceOf(holder, SOULBOUND_ID), 1);
        assertEq(license.balanceOf(holder, TRANSFERABLE_ID), 1);
    }

    function test_transferableSingleAndApprovedBatchSucceed() public {
        _register(TRANSFERABLE_ID, 2, true);
        _register(3, 1, true);
        _mint(holder, TRANSFERABLE_ID, KEY);
        _mint(holder, TRANSFERABLE_ID, KEY_2);
        _mint(holder, 3, keccak256("third"));
        vm.prank(holder);
        license.safeTransferFrom(holder, recipient, TRANSFERABLE_ID, 1, "");
        vm.prank(holder);
        license.setApprovalForAll(operator, true);
        vm.prank(operator);
        license.safeBatchTransferFrom(holder, recipient, _pair(TRANSFERABLE_ID, 3), _pair(1, 1), "");
        assertEq(license.balanceOf(recipient, TRANSFERABLE_ID), 2);
        assertEq(license.balanceOf(recipient, 3), 1);
        assertEq(license.balanceOf(holder, TRANSFERABLE_ID), 0);
        assertEq(license.licenseOf(TRANSFERABLE_ID).minted, 2);
        _assertRecord(KEY, TRANSFERABLE_ID, holder);
    }

    function test_transferableSelfAndZeroTransfersSucceed() public {
        _register(TRANSFERABLE_ID, 1, true);
        _mint(holder, TRANSFERABLE_ID, KEY);
        vm.startPrank(holder);
        license.safeTransferFrom(holder, holder, TRANSFERABLE_ID, 1, "");
        license.safeTransferFrom(holder, recipient, TRANSFERABLE_ID, 0, "");
        vm.stopPrank();
        assertEq(license.balanceOf(holder, TRANSFERABLE_ID), 1);
        assertEq(license.balanceOf(recipient, TRANSFERABLE_ID), 0);
    }

    // --- holder-only burns / no lifetime replenishment -------------------

    function test_holderBurnDoesNotRestoreSupplyOrPaymentKey() public {
        _register(SOULBOUND_ID, 1, false);
        _mint(holder, SOULBOUND_ID, KEY);
        vm.prank(holder);
        license.burn(SOULBOUND_ID, 1);
        assertEq(license.balanceOf(holder, SOULBOUND_ID), 0);
        assertEq(license.licenseOf(SOULBOUND_ID).minted, 1);
        _assertRecord(KEY, SOULBOUND_ID, holder);
        vm.expectRevert(abi.encodeWithSelector(OpenPayLicense1155.PaymentKeyConsumed.selector, KEY));
        _mint(holder, SOULBOUND_ID, KEY);
        vm.expectRevert(
            abi.encodeWithSelector(OpenPayLicense1155.SupplyCapReached.selector, SOULBOUND_ID)
        );
        _mint(holder, SOULBOUND_ID, KEY_2);
    }

    function test_holderBurnBatchPreservesLifetimeRecords() public {
        _heldLicenses();
        vm.prank(holder);
        license.burnBatch(_pair(SOULBOUND_ID, TRANSFERABLE_ID), _pair(1, 1));
        assertEq(license.balanceOf(holder, SOULBOUND_ID), 0);
        assertEq(license.balanceOf(holder, TRANSFERABLE_ID), 0);
        assertEq(license.licenseOf(SOULBOUND_ID).minted, 1);
        assertEq(license.licenseOf(TRANSFERABLE_ID).minted, 1);
        _assertRecord(KEY, SOULBOUND_ID, holder);
        _assertRecord(KEY_2, TRANSFERABLE_ID, holder);
    }

    function test_approvedOperatorCannotBurnHolderSingleOrBatch() public {
        _heldLicenses();
        vm.prank(holder);
        license.setApprovalForAll(operator, true);
        bytes memory insufficient = abi.encodeWithSelector(
            IERC1155Errors.ERC1155InsufficientBalance.selector,
            operator,
            uint256(0),
            uint256(1),
            SOULBOUND_ID
        );
        vm.startPrank(operator);
        vm.expectRevert(insufficient);
        license.burn(SOULBOUND_ID, 1);
        vm.expectRevert(insufficient);
        license.burnBatch(_pair(SOULBOUND_ID, TRANSFERABLE_ID), _pair(1, 1));
        vm.stopPrank();
        assertEq(license.balanceOf(holder, SOULBOUND_ID), 1);
        assertEq(license.balanceOf(holder, TRANSFERABLE_ID), 1);
    }

    function test_operatorBurnsOnlyOwnBalance() public {
        _heldLicenses();
        _mint(operator, SOULBOUND_ID, keccak256("operator-payment"));
        vm.prank(holder);
        license.setApprovalForAll(operator, true);
        vm.prank(operator);
        license.burn(SOULBOUND_ID, 1);
        assertEq(license.balanceOf(operator, SOULBOUND_ID), 0);
        assertEq(license.balanceOf(holder, SOULBOUND_ID), 1);
        assertEq(license.licenseOf(SOULBOUND_ID).minted, 2);
    }

    function test_duplicateBurnBatchCannotOverdrawAndRollsBack() public {
        _heldLicenses();
        vm.expectRevert(
            abi.encodeWithSelector(
                IERC1155Errors.ERC1155InsufficientBalance.selector,
                holder,
                uint256(0),
                uint256(1),
                SOULBOUND_ID
            )
        );
        vm.prank(holder);
        license.burnBatch(_pair(SOULBOUND_ID, SOULBOUND_ID), _pair(1, 1));
        assertEq(license.balanceOf(holder, SOULBOUND_ID), 1);
    }

    // --- callback rollback / reentrancy ----------------------------------

    function test_rejectingReceiverRollsBackAndSameKeyCanRetry() public {
        _register(SOULBOUND_ID, 1, false);
        RejectingLicenseReceiver rejecting = new RejectingLicenseReceiver();
        vm.expectRevert(
            abi.encodeWithSelector(
                IERC1155Errors.ERC1155InvalidReceiver.selector, address(rejecting)
            )
        );
        _mint(address(rejecting), SOULBOUND_ID, KEY);
        assertEq(license.balanceOf(address(rejecting), SOULBOUND_ID), 0);
        assertEq(license.licenseOf(SOULBOUND_ID).minted, 0);
        _assertRecord(KEY, 0, address(0));
        // 同じ受取先が修復された場合の retry (worker による wallet 付替えではない)。
        AcceptingLicenseReceiver accepting = new AcceptingLicenseReceiver();
        vm.etch(address(rejecting), address(accepting).code);
        _mint(address(rejecting), SOULBOUND_ID, KEY);
        _assertRecord(KEY, SOULBOUND_ID, address(rejecting));
        assertEq(license.balanceOf(address(rejecting), SOULBOUND_ID), 1);
    }

    function _receiver(uint64 cap, bool privileged, bool burnFirst, bool rejectAfter)
        internal
        returns (ReentrantLicenseReceiver receiver)
    {
        _register(SOULBOUND_ID, cap, false);
        receiver = new ReentrantLicenseReceiver(license, burnFirst, rejectAfter);
        if (privileged) {
            vm.prank(owner);
            license.setMinter(address(receiver));
            minter = address(receiver);
        }
    }

    function test_unprivilegedReceiverCannotReenterMint() public {
        ReentrantLicenseReceiver receiver = _receiver(2, false, false, false);
        _mint(address(receiver), SOULBOUND_ID, receiver.PAYMENT_KEY());
        assertTrue(receiver.observed());
        assertFalse(receiver.replaySucceeded());
        assertFalse(receiver.freshSucceeded());
        bytes memory unauthorized = abi.encodeWithSelector(
            OpenPayLicense1155.UnauthorizedMinter.selector, address(receiver)
        );
        assertEq(receiver.replayResult(), unauthorized);
        assertEq(receiver.freshResult(), unauthorized);
        assertEq(license.licenseOf(SOULBOUND_ID).minted, 1);
    }

    function test_minterReceiverCannotReplayButDistinctKeyWithinCapIsAllowed() public {
        ReentrantLicenseReceiver receiver = _receiver(2, true, false, false);
        _mint(address(receiver), SOULBOUND_ID, receiver.PAYMENT_KEY());
        assertTrue(receiver.observed());
        assertFalse(receiver.replaySucceeded());
        assertEq(
            receiver.replayResult(),
            abi.encodeWithSelector(
                OpenPayLicense1155.PaymentKeyConsumed.selector, receiver.PAYMENT_KEY()
            )
        );
        assertTrue(receiver.freshSucceeded());
        assertEq(license.licenseOf(SOULBOUND_ID).minted, 2);
        assertEq(license.balanceOf(address(receiver), SOULBOUND_ID), 1);
        _assertRecord(receiver.PAYMENT_KEY(), SOULBOUND_ID, address(receiver));
        _assertRecord(receiver.FRESH_KEY(), SOULBOUND_ID, receiver.OTHER_RECIPIENT());
    }

    function test_minterReceiverCannotExceedCapOnReentry() public {
        _assertReentryCap(false);
    }

    function test_minterReceiverCannotBurnAndRemintOnReentry() public {
        _assertReentryCap(true);
    }

    function _assertReentryCap(bool burnFirst) internal {
        ReentrantLicenseReceiver receiver = _receiver(1, true, burnFirst, false);
        _mint(address(receiver), SOULBOUND_ID, receiver.PAYMENT_KEY());
        assertTrue(receiver.observed());
        assertFalse(receiver.replaySucceeded());
        assertEq(
            receiver.replayResult(),
            abi.encodeWithSelector(
                OpenPayLicense1155.PaymentKeyConsumed.selector, receiver.PAYMENT_KEY()
            )
        );
        assertFalse(receiver.freshSucceeded());
        assertEq(
            receiver.freshResult(),
            abi.encodeWithSelector(OpenPayLicense1155.SupplyCapReached.selector, SOULBOUND_ID)
        );
        assertEq(license.licenseOf(SOULBOUND_ID).minted, 1);
        assertEq(license.balanceOf(address(receiver), SOULBOUND_ID), burnFirst ? 0 : 1);
        _assertRecord(receiver.PAYMENT_KEY(), SOULBOUND_ID, address(receiver));
        _assertRecord(receiver.FRESH_KEY(), 0, address(0));
    }

    function test_receiverRevertRollsBackNestedMintAndBurn() public {
        ReentrantLicenseReceiver receiver = _receiver(2, true, true, true);
        bytes32 paymentKey = receiver.PAYMENT_KEY();
        vm.expectRevert(ReentrantLicenseReceiver.ReceiverRejected.selector);
        _mint(address(receiver), SOULBOUND_ID, paymentKey);
        assertFalse(receiver.observed());
        assertEq(license.licenseOf(SOULBOUND_ID).minted, 0);
        assertEq(license.balanceOf(address(receiver), SOULBOUND_ID), 0);
        assertEq(license.balanceOf(receiver.OTHER_RECIPIENT(), SOULBOUND_ID), 0);
        _assertRecord(paymentKey, 0, address(0));
        _assertRecord(receiver.FRESH_KEY(), 0, address(0));
    }

    // --- roles / metadata repair -----------------------------------------

    function test_onlyMinterCanRegisterOrMintIncludingOwner() public {
        _register(SOULBOUND_ID, 2, false);
        address[2] memory callers = [owner, holder];
        for (uint256 i = 0; i < callers.length; ++i) {
            vm.startPrank(callers[i]);
            vm.expectRevert(
                abi.encodeWithSelector(OpenPayLicense1155.UnauthorizedMinter.selector, callers[i])
            );
            license.registerLicense(SOULBOUND_ID, 2, false, "ipfs://license", DEFINITION);
            vm.expectRevert(
                abi.encodeWithSelector(OpenPayLicense1155.UnauthorizedMinter.selector, callers[i])
            );
            license.mintFor(holder, SOULBOUND_ID, KEY);
            vm.stopPrank();
        }
    }

    function test_minterRotationAndDisable() public {
        _register(SOULBOUND_ID, 2, false);
        _mint(holder, SOULBOUND_ID, KEY);
        address nextMinter = address(0x1234);
        vm.expectEmit(true, true, false, true, address(license));
        emit OpenPayLicense1155.MinterUpdated(minter, nextMinter);
        vm.prank(owner);
        license.setMinter(nextMinter);
        vm.expectRevert(
            abi.encodeWithSelector(OpenPayLicense1155.UnauthorizedMinter.selector, minter)
        );
        _mint(holder, SOULBOUND_ID, KEY_2);
        vm.expectRevert(
            abi.encodeWithSelector(OpenPayLicense1155.UnauthorizedMinter.selector, minter)
        );
        _register(3, 1, true);
        minter = nextMinter;
        _register(3, 1, true);
        _mint(holder, SOULBOUND_ID, KEY_2);
        vm.prank(owner);
        license.setMinter(address(0));
        assertEq(license.minter(), address(0));
        vm.expectRevert(
            abi.encodeWithSelector(OpenPayLicense1155.UnauthorizedMinter.selector, minter)
        );
        _register(4, 1, true);
        vm.expectRevert(
            abi.encodeWithSelector(OpenPayLicense1155.UnauthorizedMinter.selector, minter)
        );
        _mint(holder, 3, keccak256("disabled"));
        assertEq(license.balanceOf(holder, SOULBOUND_ID), 2);
        _assertRecord(KEY, SOULBOUND_ID, holder);
        vm.prank(owner);
        license.setMinter(nextMinter);
        _mint(holder, 3, keccak256("enabled"));
    }

    function test_onlyOwnerCanSetMinterAndURI() public {
        _register(SOULBOUND_ID, 2, false);
        vm.startPrank(minter);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, minter));
        license.setMinter(recipient);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, minter));
        license.setURI(SOULBOUND_ID, "ipfs://forged");
        vm.stopPrank();
        vm.prank(owner);
        license.setURI(SOULBOUND_ID, "ipfs://repaired");
        assertEq(license.uri(SOULBOUND_ID), "ipfs://repaired");
        vm.expectRevert(
            abi.encodeWithSelector(OpenPayLicense1155.UnknownLicense.selector, uint256(99))
        );
        vm.prank(owner);
        license.setURI(99, "ipfs://unknown");
    }

    function test_ownershipRequiresAcceptanceAndRevokesOldOwner() public {
        vm.prank(owner);
        license.transferOwnership(recipient);
        assertEq(license.owner(), owner);
        assertEq(license.pendingOwner(), recipient);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, recipient)
        );
        vm.prank(recipient);
        license.setMinter(address(0));
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, holder));
        vm.prank(holder);
        license.acceptOwnership();
        vm.prank(recipient);
        license.acceptOwnership();
        assertEq(license.owner(), recipient);
        assertEq(license.pendingOwner(), address(0));
        assertEq(license.minter(), minter);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, owner));
        vm.prank(owner);
        license.setMinter(address(0));
        vm.prank(recipient);
        license.setMinter(address(0));
    }

    function test_ownerAndMinterMustRemainSeparate() public {
        vm.expectRevert(OpenPayLicense1155.OwnerIsMinter.selector);
        new OpenPayLicense1155(owner, owner);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        new OpenPayLicense1155(address(0), minter);
        vm.expectRevert(OpenPayLicense1155.OwnerIsMinter.selector);
        vm.prank(owner);
        license.setMinter(owner);
        vm.prank(owner);
        license.transferOwnership(recipient);
        vm.prank(owner);
        license.setMinter(recipient); // pending owner が後から minter になる経路も acceptance で拒否。
        vm.expectRevert(OpenPayLicense1155.OwnerIsMinter.selector);
        vm.prank(recipient);
        license.acceptOwnership();
        assertEq(license.owner(), owner);
        assertEq(license.pendingOwner(), recipient);
        vm.prank(owner);
        license.setMinter(address(0));
        vm.prank(recipient);
        license.acceptOwnership();
        assertEq(license.owner(), recipient);
    }

    function test_initialMinterCanBeDisabled() public {
        OpenPayLicense1155 disabled = new OpenPayLicense1155(owner, address(0));
        assertEq(disabled.owner(), owner);
        assertEq(disabled.minter(), address(0));
        vm.expectRevert(
            abi.encodeWithSelector(OpenPayLicense1155.UnauthorizedMinter.selector, minter)
        );
        vm.prank(minter);
        disabled.registerLicense(1, 1, false, "", DEFINITION);
    }

    function test_renounceRevertsAndPendingTransferCanBeCancelled() public {
        vm.prank(owner);
        license.transferOwnership(recipient);
        vm.expectRevert(OpenPayLicense1155.RenounceOwnershipDisabled.selector);
        vm.prank(owner);
        license.renounceOwnership();
        assertEq(license.owner(), owner);
        vm.prank(owner);
        license.transferOwnership(address(0));
        assertEq(license.pendingOwner(), address(0));
        assertEq(license.owner(), owner);
    }

    function test_standardInterfacesAndUnknownViews() public view {
        assertTrue(license.supportsInterface(0x01ffc9a7)); // ERC165
        assertTrue(license.supportsInterface(0xd9b67a26)); // ERC1155
        assertTrue(license.supportsInterface(0x0e89341c)); // ERC1155MetadataURI
        assertFalse(license.supportsInterface(0xffffffff));
        assertFalse(license.licenseOf(99).exists);
        assertEq(license.uri(99), "");
        _assertRecord(KEY, 0, address(0));
    }

    // --- golden vectors: tests/lib/license/paymentKey.test.ts と同じ固定値 ---

    function test_goldenVector_paymentKeyPolygonAndAmoy() public view {
        assertEq(
            license.PAYMENT_KEY_V1(),
            0x581b0572da6417f87ae90ea662ad154de7735776fa3d9c3729289ff7e7448fdf
        );
        address paymentToken = 0x1111111111111111111111111111111111111111;
        address payer = 0x2222222222222222222222222222222222222222;
        bytes32 nonce = 0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef;
        assertEq(
            license.computePaymentKey(137, paymentToken, payer, nonce),
            0xd1b175c2ad9cd219287b8a17254555188459c156a1a0174c0025821d6d5ff5e8
        );
        assertEq(
            license.computePaymentKey(80002, paymentToken, payer, nonce),
            0xac1088654c57359a3eceade2018326d23c70d9b278157d419876fd83e8ac420b
        );
    }

    function test_goldenVector_paymentKeyUint256AndZeroFields() public view {
        assertEq(
            license.computePaymentKey(
                340282366920938463463374607431768211593, address(0), address(0), bytes32(0)
            ),
            0xac66b57dcec1ff2688ea56a7425f1980994439b91968ff6f0f9cd0934e7c9609
        );
    }

    function test_goldenVector_tokenIdUsesEntireHostedString() public view {
        assertEq(
            license.computeTokenId("h_000102030405060708090a0b0c0d0e0f"),
            uint256(0xf1d52e03274f94c6c02c6ef09db2a0408a4962266d56721d5d6cf0bccdbecbb7)
        );
        assertEq(
            license.computeTokenId("h_ffffffffffffffffffffffffffffffff"),
            uint256(0x43cc17a6178e5732517dbbb1ecdeedb06c1379dc9e5250b56ed265c2dd5891cd)
        );
    }
}
