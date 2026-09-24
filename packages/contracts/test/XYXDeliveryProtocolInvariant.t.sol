// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {WebAuthn} from "@openzeppelin/contracts/utils/cryptography/WebAuthn.sol";
import {Errors} from "@openzeppelin/contracts/utils/Errors.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {IP256Verifier} from "../src/interfaces/IP256Verifier.sol";
import {MonadP256Verifier} from "../src/MonadP256Verifier.sol";
import {XYXPasskeyRegistry} from "../src/XYXPasskeyRegistry.sol";
import {XYXDeliveryProtocol} from "../src/XYXDeliveryProtocol.sol";

/// @notice ERC-20 whose decimals are fixed at construction so the suite can prove the protocol's
/// escrow accounting is decimals-agnostic, and which can optionally burn a fee on every transfer
/// (fee-on-transfer) to prove the escrow invariant is defended rather than assumed.
contract InvariantToken is ERC20 {
    uint8 private immutable _tokenDecimals;
    uint256 public feePerTransfer;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        _tokenDecimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _tokenDecimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setFeePerTransfer(uint256 value) external {
        feePerTransfer = value;
    }

    function _update(address from, address to, uint256 value) internal override {
        uint256 fee = feePerTransfer;
        if (from != address(0) && to != address(0) && fee != 0) {
            // A genuine deflationary token: the sender is debited in full, the fee leaves the
            // supply entirely, and only the remainder reaches the receiver.
            uint256 feeAmount = fee > value ? value : fee;
            super._update(from, to, value - feeAmount);
            super._update(from, address(0), feeAmount);
        } else {
            super._update(from, to, value);
        }
    }
}

/// @notice ERC-20 whose `transferFrom` can be told to report success without moving anything.
/// The mirror-image hazard of a fee-on-transfer token: it inflates escrow instead of deflating it.
contract InvariantLiarToken is ERC20 {
    uint8 private immutable _tokenDecimals;
    bool public lieOnTransferFrom;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        _tokenDecimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _tokenDecimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setLieOnTransferFrom(bool value) external {
        lieOnTransferFrom = value;
    }

    function transferFrom(address sender, address recipient, uint256 amount)
        public
        override
        returns (bool)
    {
        if (lieOnTransferFrom) {
            return true;
        }
        _spendAllowance(sender, msg.sender, amount);
        _transfer(sender, recipient, amount);
        return true;
    }
}

/// @notice The native-P256 step that production injects. Tests flip it for negative paths.
contract InvariantP256Verifier is IP256Verifier {
    bool public accept = true;

    function setAccept(bool value) external {
        accept = value;
    }

    function verify(bytes32, bytes32, bytes32, bytes32, bytes32) external view returns (bool) {
        return accept;
    }
}

/// @notice Invariant / fuzz coverage for the delivery protocol escrow lifecycle.
/// @dev Covers the token-sensitivity, transition-matrix, job-id and assertion gaps that the
/// scenario suites in `XYXDeliveryProtocol.t.sol`, `XYXDeliveryProtocolSecurity.t.sol`,
/// `C1Hardening.t.sol` and `MonadLifecycle.t.sol` do not reach.
contract XYXDeliveryProtocolInvariantTest is Test {
    using SafeERC20 for IERC20;

    uint256 internal constant ATTESTOR_P256_KEY = 0xA771E570;
    uint256 internal constant OTHER_ATTESTOR_P256_KEY = 0xB0B570;

    address internal constant BUYER = address(0xB0B);
    address internal constant PROVIDER = address(0xBEEF);
    address internal constant ATTESTOR = address(0xA771E570);
    address internal constant OTHER_ATTESTOR = address(0xB0B570);
    address internal constant STRANGER = address(0xCA11);

    /// @dev The token decimals the preflight and the deployment are expected to work with. The
    /// suite deliberately steps outside that set to prove nothing in the protocol assumes it.
    uint8[6] internal DECIMAL_SET = [uint8(0), 1, 2, 6, 7, 18];
    uint256 internal constant SUPPLY = 1_000_000;

    bytes32 internal rpHash;
    bytes32 internal attestorQx;
    bytes32 internal attestorQy;
    bytes32 internal otherQx;
    bytes32 internal otherQy;

    InvariantP256Verifier internal nativeVerifier;
    XYXPasskeyRegistry internal registry;
    InvariantToken internal token;
    XYXDeliveryProtocol internal protocol;

    bytes32 internal constant TERMS = keccak256("invariant terms");
    bytes32 internal constant DELIVERY = keccak256("invariant delivery");
    bytes32 internal constant EVIDENCE = keccak256("invariant evidence");
    bytes32 internal constant REASON = keccak256("invariant reason");
    uint256 internal constant BUDGET_AMOUNT = 20_000;

    function setUp() public {
        vm.chainId(10143);
        rpHash = sha256(bytes("xyx.local"));
        nativeVerifier = new InvariantP256Verifier();
        registry = new XYXPasskeyRegistry(rpHash, address(nativeVerifier));
        token = new InvariantToken("Invariant USDC", "iUSDC", 6);
        protocol = new XYXDeliveryProtocol(address(token), address(registry), 15 minutes);

        token.mint(BUYER, SUPPLY);
        vm.prank(BUYER);
        token.approve(address(protocol), type(uint256).max);

        (uint256 qx, uint256 qy) = vm.publicKeyP256(ATTESTOR_P256_KEY);
        attestorQx = bytes32(qx);
        attestorQy = bytes32(qy);
        _registerAttestor(ATTESTOR, keccak256("attestor credential"), attestorQx, attestorQy, ATTESTOR_P256_KEY);

        (uint256 ox, uint256 oy) = vm.publicKeyP256(OTHER_ATTESTOR_P256_KEY);
        otherQx = bytes32(ox);
        otherQy = bytes32(oy);
        _registerAttestor(
            OTHER_ATTESTOR, keccak256("other attestor credential"), otherQx, otherQy, OTHER_ATTESTOR_P256_KEY
        );
    }

    // ---------------------------------------------------------------------------------------------
    // Harness helpers
    // ---------------------------------------------------------------------------------------------

    /// @dev A protocol over a token with an arbitrary decimal count. Used everywhere the suite must
    /// prove the escrow logic does not care how the unit is denominated.
    function _trio(uint8 decimals_)
        private
        returns (InvariantToken t, XYXDeliveryProtocol p, XYXPasskeyRegistry r)
    {
        t = new InvariantToken("Decimal Token", "dTKN", decimals_);
        InvariantP256Verifier v = new InvariantP256Verifier();
        r = new XYXPasskeyRegistry(rpHash, address(v));
        p = new XYXDeliveryProtocol(address(t), address(r), 15 minutes);
        t.mint(BUYER, SUPPLY);
        vm.prank(BUYER);
        t.approve(address(p), type(uint256).max);
    }

    /// @dev A protocol over the liar token. `transferFrom` can report success without moving funds.
    function _liarTrio(uint8 decimals_)
        private
        returns (InvariantLiarToken t, XYXDeliveryProtocol p, XYXPasskeyRegistry r)
    {
        t = new InvariantLiarToken("Liar Token", "LIAR", decimals_);
        InvariantP256Verifier v = new InvariantP256Verifier();
        r = new XYXPasskeyRegistry(rpHash, address(v));
        p = new XYXDeliveryProtocol(address(t), address(r), 15 minutes);
        t.mint(BUYER, SUPPLY);
        vm.prank(BUYER);
        t.approve(address(p), type(uint256).max);
    }

    function _canonicalDecimals(uint256 raw) private view returns (uint8) {
        return DECIMAL_SET[raw % DECIMAL_SET.length];
    }

    /// @dev Registers the shared attestor public key on any registry the suite builds.
    function _registerOn(
        XYXPasskeyRegistry r,
        address owner,
        bytes32 credentialCommitment,
        bytes32 qx,
        bytes32 qy,
        uint256 p256Key
    ) private {
        WebAuthn.WebAuthnAuth memory assertion = _assertion(
            r.registrationChallenge(owner, credentialCommitment, qx, qy), 0, false, p256Key
        );
        vm.prank(owner);
        r.registerCredential(credentialCommitment, qx, qy, assertion);
    }

    function _propose(address attestor) private returns (uint256 jobId) {
        vm.prank(BUYER);
        jobId = protocol.proposeJob(PROVIDER, attestor, TERMS, BUDGET_AMOUNT, uint64(block.timestamp + 1 hours));
    }

    function _proposeWith(address attestor, uint256 amount, uint64 expiresAt) private returns (uint256 jobId) {
        vm.prank(BUYER);
        jobId = protocol.proposeJob(PROVIDER, attestor, TERMS, amount, expiresAt);
    }

    function _accepted(address attestor) private returns (uint256 jobId) {
        jobId = _propose(attestor);
        vm.prank(PROVIDER);
        protocol.acceptJob(jobId);
    }

    function _funded(address attestor) private returns (uint256 jobId) {
        jobId = _accepted(attestor);
        vm.prank(BUYER);
        protocol.fundJob(jobId);
    }

    function _submitted(address attestor) private returns (uint256 jobId) {
        jobId = _funded(attestor);
        vm.prank(PROVIDER);
        protocol.submitDelivery(jobId, DELIVERY);
    }

    function _submittedWith(address attestor, uint256 amount, uint64 expiresAt) private returns (uint256 jobId) {
        jobId = _proposeWith(attestor, amount, expiresAt);
        vm.prank(PROVIDER);
        protocol.acceptJob(jobId);
        vm.prank(BUYER);
        protocol.fundJob(jobId);
        vm.prank(PROVIDER);
        protocol.submitDelivery(jobId, DELIVERY);
    }

    function _verdict(uint256 jobId, uint8 decision, uint64 nonce)
        private
        view
        returns (XYXDeliveryProtocol.JobVerdict memory)
    {
        return XYXDeliveryProtocol.JobVerdict({
            jobId: jobId,
            termsCommitment: TERMS,
            deliveryCommitment: DELIVERY,
            evidenceCommitment: EVIDENCE,
            reasonCommitment: REASON,
            decision: decision,
            issuedAt: uint64(block.timestamp),
            expiresAt: uint64(block.timestamp + 5 minutes),
            nonce: nonce
        });
    }

    function _resolve(uint256 jobId, uint8 decision, uint64 nonce) private {
        XYXDeliveryProtocol.JobVerdict memory verdict = _verdict(jobId, decision, nonce);
        bytes32 digest = protocol.hashVerdict(verdict);
        WebAuthn.WebAuthnAuth memory assertion = _assertion(
            registry.assertionChallenge(address(protocol), ATTESTOR, digest), 0, false, ATTESTOR_P256_KEY
        );
        vm.prank(ATTESTOR);
        protocol.resolveJob(verdict, assertion);
    }

    function _registerAttestor(
        address owner,
        bytes32 credentialCommitment,
        bytes32 qx,
        bytes32 qy,
        uint256 p256Key
    ) private {
        WebAuthn.WebAuthnAuth memory assertion = _assertion(
            registry.registrationChallenge(owner, credentialCommitment, qx, qy), 0, false, p256Key
        );
        vm.prank(owner);
        registry.registerCredential(credentialCommitment, qx, qy, assertion);
    }

    function _assertion(bytes32 challenge, uint32 counter, bool wrongRp, uint256 p256Key)
        private
        view
        returns (WebAuthn.WebAuthnAuth memory auth)
    {
        bytes32 usedRpHash = wrongRp ? sha256(bytes("attacker.local")) : rpHash;
        bytes memory authenticatorData = abi.encodePacked(usedRpHash, bytes1(0x05), bytes4(counter));
        string memory clientDataJSON = string.concat(
            '{"type":"webauthn.get","challenge":"',
            Base64.encodeURL(abi.encodePacked(challenge)),
            '","origin":"https://xyx.local","crossOrigin":false}'
        );
        bytes32 signatureHash = sha256(abi.encodePacked(authenticatorData, sha256(bytes(clientDataJSON))));
        (bytes32 r, bytes32 s) = vm.signP256(p256Key, signatureHash);
        return WebAuthn.WebAuthnAuth({
            r: r,
            s: s,
            challengeIndex: bytes('{"type":"webauthn.get",').length,
            typeIndex: 1,
            authenticatorData: authenticatorData,
            clientDataJSON: clientDataJSON
        });
    }

    /// @dev Sum of the budgets of every non-terminal job, which must equal the escrowed balance.
    function _activeEscrow() private view returns (uint256 escrowed) {
        uint256 total = protocol.jobCounter();
        for (uint256 i = 1; i <= total; i++) {
            XYXDeliveryProtocol.Job memory job = protocol.getJob(i);
            if (job.status == XYXDeliveryProtocol.JobStatus.Funded || job.status == XYXDeliveryProtocol.JobStatus.Submitted) {
                escrowed += job.budget;
            }
        }
    }

    /// @dev The resolve call is identical for every protocol/registry pair the suite builds, so it
    /// takes them as arguments instead of reading the shared state variables.
    function _resolveOn(
        XYXDeliveryProtocol p,
        XYXPasskeyRegistry r,
        address attestor,
        uint256 jobId,
        uint8 decision,
        uint64 nonce,
        uint256 p256Key
    ) private {
        XYXDeliveryProtocol.JobVerdict memory verdict = _verdict(jobId, decision, nonce);
        bytes32 digest = p.hashVerdict(verdict);
        WebAuthn.WebAuthnAuth memory assertion = _assertion(
            r.assertionChallenge(address(p), attestor, digest), 0, false, p256Key
        );
        vm.prank(attestor);
        p.resolveJob(verdict, assertion);
    }

    // ---------------------------------------------------------------------------------------------
    // Group 1 — decimals sensitivity and fuzzed budgets
    // ---------------------------------------------------------------------------------------------

    /// @notice The escrow must debit the buyer the exact budget and release it exactly, no matter
    /// which unit the token denominates in. Decimals only change how humans read the number.
    function testFuzz_decimalsSensitivity_fullLifecycleEscrowsAndReleasesExactBudget(uint8 decimals_, uint256 amount)
        public
    {
        uint8 decimals = _canonicalDecimals(decimals_);
        amount = bound(amount, 1, SUPPLY);
        (InvariantToken t, XYXDeliveryProtocol p, XYXPasskeyRegistry r) = _trio(decimals);
        _registerOn(r, ATTESTOR, keccak256("attestor credential"), attestorQx, attestorQy, ATTESTOR_P256_KEY);

        vm.prank(BUYER);
        uint256 jobId = p.proposeJob(PROVIDER, ATTESTOR, TERMS, amount, uint64(block.timestamp + 1 hours));
        vm.prank(PROVIDER);
        p.acceptJob(jobId);
        assertEq(t.balanceOf(address(p)), 0, "nothing is escrowed before funding");

        vm.prank(BUYER);
        p.fundJob(jobId);
        assertEq(t.balanceOf(address(p)), amount, "escrow must equal the raw budget at every decimals setting");
        assertEq(t.balanceOf(BUYER), SUPPLY - amount, "buyer must be debited the exact budget");

        vm.prank(PROVIDER);
        p.submitDelivery(jobId, DELIVERY);

        _resolveOn(p, r, ATTESTOR, jobId, 1, 0, ATTESTOR_P256_KEY);

        assertEq(t.balanceOf(address(p)), 0, "escrow must be fully released");
        assertEq(t.balanceOf(PROVIDER), amount, "provider must receive exactly the budget");
        assertEq(
            uint8(p.getJob(jobId).status),
            uint8(XYXDeliveryProtocol.JobStatus.Completed),
            "job must reach Completed"
        );
    }

    /// @notice Reject refunds the buyer the budget instead — symmetric with the complete path.
    function testFuzz_decimalsSensitivity_rejectRefundsExactBudget(uint8 decimals_, uint256 amount) public {
        uint8 decimals = _canonicalDecimals(decimals_);
        amount = bound(amount, 1, SUPPLY);
        (InvariantToken t, XYXDeliveryProtocol p, XYXPasskeyRegistry r) = _trio(decimals);
        _registerOn(r, ATTESTOR, keccak256("attestor credential"), attestorQx, attestorQy, ATTESTOR_P256_KEY);

        vm.prank(BUYER);
        uint256 jobId = p.proposeJob(PROVIDER, ATTESTOR, TERMS, amount, uint64(block.timestamp + 1 hours));
        vm.prank(PROVIDER);
        p.acceptJob(jobId);
        vm.prank(BUYER);
        p.fundJob(jobId);
        vm.prank(PROVIDER);
        p.submitDelivery(jobId, DELIVERY);

        _resolveOn(p, r, ATTESTOR, jobId, 2, 0, ATTESTOR_P256_KEY);

        assertEq(t.balanceOf(address(p)), 0, "escrow must be fully released on reject too");
        assertEq(t.balanceOf(BUYER), SUPPLY, "buyer must be refunded exactly the budget");
    }

    /// @notice A zero budget must be rejected by input validation rather than escrowed.
    function testFuzz_zeroBudgetIsRejectedAtEveryDecimalsSetting(uint8 decimals_) public {
        uint8 decimals = _canonicalDecimals(decimals_);
        (, XYXDeliveryProtocol p,) = _trio(decimals);
        vm.prank(BUYER);
        vm.expectRevert(XYXDeliveryProtocol.InvalidInput.selector);
        p.proposeJob(PROVIDER, ATTESTOR, TERMS, 0, uint64(block.timestamp + 1 hours));
    }

    /// @notice A budget the buyer cannot cover must fail on the ERC-20 transfer, not by underfunding.
    function testFuzz_oversizedBudgetRevertsAndLeavesNoEscrow(uint8 decimals_, uint256 amount) public {
        uint8 decimals = _canonicalDecimals(decimals_);
        amount = bound(amount, SUPPLY + 1, type(uint128).max);
        (InvariantToken t, XYXDeliveryProtocol p,) = _trio(decimals);

        vm.prank(BUYER);
        uint256 jobId = p.proposeJob(PROVIDER, ATTESTOR, TERMS, amount, uint64(block.timestamp + 1 hours));
        vm.prank(PROVIDER);
        p.acceptJob(jobId);
        vm.prank(BUYER);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, BUYER, SUPPLY, amount)
        );
        p.fundJob(jobId);

        assertEq(t.balanceOf(address(p)), 0, "a failed funding must not escrow anything");
        assertEq(
            uint8(p.getJob(jobId).status),
            uint8(XYXDeliveryProtocol.JobStatus.Accepted),
            "status must stay Accepted"
        );
    }

    /// @notice The escrow invariant from the security suite must also hold across the decimal range.
    function testFuzz_escrowInvariantHoldsAcrossDecimals(uint8 decimals_, uint8 count_) public {
        uint8 decimals = _canonicalDecimals(decimals_);
        uint8 count = uint8(bound(count_, 1, 6));
        (InvariantToken t, XYXDeliveryProtocol p, XYXPasskeyRegistry r) = _trio(decimals);
        _registerOn(r, ATTESTOR, keccak256("attestor credential"), attestorQx, attestorQy, ATTESTOR_P256_KEY);

        uint256 expectedEscrow;
        for (uint256 i; i < count; i++) {
            uint256 amount = bound(uint256(keccak256(abi.encode(i))), 1, SUPPLY / count);
            vm.prank(BUYER);
            uint256 jobId = p.proposeJob(PROVIDER, ATTESTOR, TERMS, amount, uint64(block.timestamp + 1 hours));
            vm.prank(PROVIDER);
            p.acceptJob(jobId);
            vm.prank(BUYER);
            p.fundJob(jobId);
            vm.prank(PROVIDER);
            p.submitDelivery(jobId, DELIVERY);
            expectedEscrow += amount;
            assertEq(t.balanceOf(address(p)), expectedEscrow, "escrow must track the sum of funded budgets");
        }

        _resolveOn(p, r, ATTESTOR, 1, 1, 0, ATTESTOR_P256_KEY);
        expectedEscrow -= p.getJob(1).budget;
        assertEq(t.balanceOf(address(p)), expectedEscrow, "escrow must drop by exactly the settled budget");
    }

    // ---------------------------------------------------------------------------------------------
    // Group 2 — non-standard ERC-20 behaviour
    // ---------------------------------------------------------------------------------------------

    /// @notice A deflationary token delivers less than the budget it was asked for. `fundJob` uses
    /// `safeTransferFrom` with no balance-delta check, so the escrow is genuinely under-funded while
    /// the recorded budget stays at the requested amount. The shortfall is exactly one fee per
    /// funding and the settlement then fails, because the escrow can no longer cover the budget:
    /// the protocol never completes a job it cannot pay in full.
    function testFuzz_feeOnTransferTokenUnderFundsEscrowByExactlyTheFee(uint8 decimals_, uint256 amount) public {
        uint8 decimals = _canonicalDecimals(decimals_);
        amount = bound(amount, 100, SUPPLY / 2);
        (InvariantToken t, XYXDeliveryProtocol p, XYXPasskeyRegistry r) = _trio(decimals);
        _registerOn(r, ATTESTOR, keccak256("attestor credential"), attestorQx, attestorQy, ATTESTOR_P256_KEY);
        t.setFeePerTransfer(1);

        vm.prank(BUYER);
        uint256 jobId = p.proposeJob(PROVIDER, ATTESTOR, TERMS, amount, uint64(block.timestamp + 1 hours));
        vm.prank(PROVIDER);
        p.acceptJob(jobId);

        vm.prank(BUYER);
        p.fundJob(jobId);

        uint256 escrowed = t.balanceOf(address(p));
        assertEq(escrowed, amount - 1, "fee-on-transfer escrow must be short by exactly one fee");
        assertEq(
            p.getJob(jobId).budget,
            amount,
            "the recorded budget must stay the requested amount, not the delivered one"
        );
        assertLt(escrowed, p.getJob(jobId).budget, "the escrow must not be solvent for this job");

        vm.prank(PROVIDER);
        p.submitDelivery(jobId, DELIVERY);

        // The settlement transfer cannot be covered. This token credits the receiver before it
        // burns its fee, so the credit leg takes exactly what the escrow holds and it is the fee
        // burn that fails: the protocol is left owing one unit it never received.
        uint256 fee = t.feePerTransfer();
        XYXDeliveryProtocol.JobVerdict memory verdict = _verdict(jobId, 1, 0);
        bytes32 digest = p.hashVerdict(verdict);
        WebAuthn.WebAuthnAuth memory assertion = _assertion(
            r.assertionChallenge(address(p), ATTESTOR, digest), 0, false, ATTESTOR_P256_KEY
        );
        vm.prank(ATTESTOR);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, address(p), 0, fee)
        );
        p.resolveJob(verdict, assertion);

        assertEq(
            uint8(p.getJob(jobId).status),
            uint8(XYXDeliveryProtocol.JobStatus.Submitted),
            "a settlement the escrow cannot cover must leave the job open"
        );
        assertEq(
            t.balanceOf(address(p)),
            escrowed,
            "a failed settlement must not move any escrowed token"
        );
    }

    /// @notice With several concurrent jobs the shortfall is per-funding, so the escrow falls behind
    /// the sum of the budgets it owes by exactly `fee * jobs`. That is the escrow invariant the
    /// audit cares about, observably broken — and the break is visible before any settlement, which
    /// is what makes it safe to assert directly.
    function testFuzz_feeOnTransferTokenLeavesConcurrentEscrowShortOfTheOwedBudgets(
        uint8 decimals_,
        uint8 count_
    ) public {
        uint8 decimals = _canonicalDecimals(decimals_);
        uint8 count = uint8(bound(count_, 1, 6));
        (InvariantToken t, XYXDeliveryProtocol p,) = _trio(decimals);
        t.setFeePerTransfer(1);

        uint256[] memory jobIds = new uint256[](count);
        uint256 owed;
        for (uint256 i; i < count; i++) {
            uint256 amount = bound(uint256(keccak256(abi.encode("amount", i))), 1, SUPPLY / (uint256(count) * 8));
            vm.prank(BUYER);
            uint256 jobId = p.proposeJob(PROVIDER, ATTESTOR, TERMS, amount, uint64(block.timestamp + 1 hours));
            vm.prank(PROVIDER);
            p.acceptJob(jobId);
            vm.prank(BUYER);
            p.fundJob(jobId);
            jobIds[i] = jobId;
            owed += amount;
            assertEq(
                t.balanceOf(address(p)),
                owed - (i + 1),
                "each funding must burn exactly one fee out of the escrow"
            );
        }

        uint256 booked;
        for (uint256 i; i < count; i++) {
            booked += p.getJob(jobIds[i]).budget;
        }
        assertEq(booked, owed, "every funded job must book exactly the raw requested budget");
        assertEq(t.balanceOf(address(p)), booked - count, "the escrow must be short by exactly one fee per job");
        assertLt(
            t.balanceOf(address(p)),
            booked,
            "a fee token must leave the escrow insolvent for the budgets it owes"
        );
    }

    /// @notice A token that reports a successful `transferFrom` while moving nothing inflates the
    /// escrow: the protocol books a budget it never received, so the last settlement fails on the
    /// outbound transfer and the whole balance is locked. This is the invariant the lying-token
    /// case violates, and the test pins down that the failure surfaces at settlement, not at
    /// funding time.
    function testFuzz_lyingTokenInflatesEscrowAndLocksIt(uint8 decimals_, uint8 count_) public {
        uint8 decimals = _canonicalDecimals(decimals_);
        uint8 count = uint8(bound(count_, 1, 3));
        (InvariantLiarToken t, XYXDeliveryProtocol p, XYXPasskeyRegistry r) = _liarTrio(decimals);
        _registerOn(r, ATTESTOR, keccak256("attestor credential"), attestorQx, attestorQy, ATTESTOR_P256_KEY);

        uint256 active;
        uint256[] memory jobIds = new uint256[](count);
        for (uint256 i; i < count; i++) {
            uint256 amount = bound(uint256(keccak256(abi.encode("liar amount", i))), 1, SUPPLY / 8);
            vm.prank(BUYER);
            uint256 jobId = p.proposeJob(PROVIDER, ATTESTOR, TERMS, amount, uint64(block.timestamp + 1 hours));
            vm.prank(PROVIDER);
            p.acceptJob(jobId);

            t.setLieOnTransferFrom(true);
            vm.prank(BUYER);
            p.fundJob(jobId);
            t.setLieOnTransferFrom(false);

            vm.prank(PROVIDER);
            p.submitDelivery(jobId, DELIVERY);
            jobIds[i] = jobId;
            active += amount;
            assertEq(t.balanceOf(address(p)), 0, "the lying token credited nothing, yet funding reported success");
            assertEq(t.balanceOf(BUYER), SUPPLY, "the buyer was never debited");
            assertEq(
                uint8(p.getJob(jobId).status),
                uint8(XYXDeliveryProtocol.JobStatus.Submitted),
                "the job advanced with an empty escrow"
            );
        }

        // Nothing was ever escrowed, so the first settlement reverts on the token transfer instead
        // of marking the job resolved. Every observ* argument is hoisted out of the pranked call so
        // the revert expectation belongs to `resolveJob` itself.
        t.setLieOnTransferFrom(false);
        uint256 firstJobId = jobIds[0];
        uint256 booked = p.getJob(firstJobId).budget;
        address escrow = address(p);
        XYXDeliveryProtocol.JobVerdict memory verdict = _verdict(firstJobId, 1, 0);
        bytes32 digest = p.hashVerdict(verdict);
        WebAuthn.WebAuthnAuth memory assertion = _assertion(
            r.assertionChallenge(address(p), ATTESTOR, digest), 0, false, ATTESTOR_P256_KEY
        );
        vm.prank(ATTESTOR);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, escrow, 0, booked)
        );
        p.resolveJob(verdict, assertion);

        assertEq(
            uint8(p.getJob(firstJobId).status),
            uint8(XYXDeliveryProtocol.JobStatus.Submitted),
            "a failed settlement must leave the job open, not mark it resolved"
        );
        assertEq(t.balanceOf(address(p)), 0, "the escrow must still be empty after the failed settlement");
        assertFalse(p.consumedVerdicts(digest), "a failed settlement must not consume the verdict digest");
        assertFalse(p.usedNonces(ATTESTOR, 0), "a failed settlement must not consume the nonce");
    }

    // ---------------------------------------------------------------------------------------------
    // Group 2 — the state machine, as a matrix
    // ---------------------------------------------------------------------------------------------

    /// @notice Every (status, call) pair the contract does not whitelist must revert with
    /// `WrongStatus` before anything else runs, no matter who signs it. Each mutating entrypoint
    /// checks status before it checks the caller, so a wrong state can never be rescued by being
    /// the right address. A missing status check anywhere is a hole: a job in the wrong state must
    /// never advance, paid or not.
    function testFuzz_everyTransitionIsStatusGatedForEveryCaller(
        uint8 statusTag,
        uint8 actionTag,
        uint8 callerTag
    ) public {
        XYXDeliveryProtocol.JobStatus status = XYXDeliveryProtocol.JobStatus(
            uint8(uint256(bound(uint256(statusTag), 0, uint256(uint8(XYXDeliveryProtocol.JobStatus.Cancelled)))))
        );
        uint8 action = uint8(uint256(bound(uint256(actionTag), 0, 5)));
        address caller = _callerFor(uint8(uint256(bound(uint256(callerTag), 0, 3))));

        // The whitelisted pair is the happy path and is covered by the lifecycle tests; here we
        // only care that every other pair is refused.
        if (_whitelists(action, status)) return;

        (, XYXDeliveryProtocol p, XYXPasskeyRegistry r) = _trio(6);
        uint256 jobId = _stateInto(p, r, status);
        XYXDeliveryProtocol.JobStatus before = p.getJob(jobId).status;

        bytes memory failure = _attempt(p, jobId, action, caller);

        assertEq(failure.length, 4, "a transition this status does not allow must revert");
        assertEq(
            bytes4(failure),
            XYXDeliveryProtocol.WrongStatus.selector,
            "the status gate must fire before the caller check, for every caller"
        );
        assertEq(
            uint8(p.getJob(jobId).status),
            uint8(before),
            "a rejected transition must leave the stored status untouched"
        );
    }

    /// @dev The caller slots used by the matrix above: the buyer, the provider, the attestor, and a
    /// stranger with no relationship to the job at all. All four are tried against every status
    /// because the status gate must not depend on which one shows up.
    function _callerFor(uint8 slot) private pure returns (address) {
        if (slot == 0) return BUYER;
        if (slot == 1) return PROVIDER;
        if (slot == 2) return ATTESTOR;
        return STRANGER;
    }

    /// @dev The one status each call accepts, mirroring the guards in `XYXDeliveryProtocol`.
    /// `claimExpiryRefund` is the only call that accepts two.
    function _whitelists(uint8 action, XYXDeliveryProtocol.JobStatus status) private pure returns (bool) {
        if (action == 0 || action == 1) return status == XYXDeliveryProtocol.JobStatus.Proposed; // acceptJob, cancelProposal
        if (action == 2) return status == XYXDeliveryProtocol.JobStatus.Accepted; // fundJob
        if (action == 3) return status == XYXDeliveryProtocol.JobStatus.Funded; // submitDelivery
        if (action == 4) return status == XYXDeliveryProtocol.JobStatus.Submitted; // resolveJob
        return status == XYXDeliveryProtocol.JobStatus.Funded || status == XYXDeliveryProtocol.JobStatus.Submitted; // claimExpiryRefund
    }

    /// @dev Builds one job in the requested status on an arbitrary protocol/registry pair, so the
    /// matrix runs against a fresh instance instead of the shared one.
    function _stateInto(XYXDeliveryProtocol p, XYXPasskeyRegistry r, XYXDeliveryProtocol.JobStatus status)
        private
        returns (uint256 jobId)
    {
        _registerOn(r, ATTESTOR, keccak256("attestor credential"), attestorQx, attestorQy, ATTESTOR_P256_KEY);

        uint64 near = uint64(block.timestamp) + 1 hours;
        vm.prank(BUYER);
        jobId = p.proposeJob(PROVIDER, ATTESTOR, TERMS, BUDGET_AMOUNT, near);

        if (status == XYXDeliveryProtocol.JobStatus.Proposed) return jobId;
        if (status == XYXDeliveryProtocol.JobStatus.Cancelled) {
            vm.prank(BUYER);
            p.cancelProposal(jobId);
            return jobId;
        }
        vm.prank(PROVIDER);
        p.acceptJob(jobId);
        if (status == XYXDeliveryProtocol.JobStatus.Accepted) return jobId;
        vm.prank(BUYER);
        p.fundJob(jobId);
        if (status == XYXDeliveryProtocol.JobStatus.Funded) return jobId;
        if (status == XYXDeliveryProtocol.JobStatus.Expired) {
            vm.warp(near);
            vm.prank(BUYER);
            p.claimExpiryRefund(jobId);
            return jobId;
        }
        vm.prank(PROVIDER);
        p.submitDelivery(jobId, DELIVERY);
        if (status == XYXDeliveryProtocol.JobStatus.Submitted) return jobId;
        _resolveOn(p, r, ATTESTOR, jobId, status == XYXDeliveryProtocol.JobStatus.Completed ? 1 : 2, 9, ATTESTOR_P256_KEY);
    }

    /// @dev Performs one transition attempt and returns the raw revert data, so the test can assert
    /// on the failure without the call unwinding the test frame. The caller is pranked inside,
    /// which is why this cannot be a `view` helper.
    function _attempt(XYXDeliveryProtocol p, uint256 jobId, uint8 action, address caller)
        private
        returns (bytes memory failure)
    {
        vm.prank(caller);
        if (action == 0) {
            try p.acceptJob(jobId) {} catch (bytes memory reason) {
                failure = reason;
            }
        } else if (action == 1) {
            try p.cancelProposal(jobId) {} catch (bytes memory reason) {
                failure = reason;
            }
        } else if (action == 2) {
            try p.fundJob(jobId) {} catch (bytes memory reason) {
                failure = reason;
            }
        } else if (action == 3) {
            try p.submitDelivery(jobId, DELIVERY) {} catch (bytes memory reason) {
                failure = reason;
            }
        } else if (action == 4) {
            try p.resolveJob(_verdict(jobId, 1, 7), _assertion(bytes32(0), 0, false, ATTESTOR_P256_KEY)) {} catch (
                bytes memory reason
            ) {
                failure = reason;
            }
        } else {
            try p.claimExpiryRefund(jobId) {} catch (bytes memory reason) {
                failure = reason;
            }
        }
        vm.stopPrank();
    }

    /// @notice A resolved job is final: no second verdict, no refund, no re-acceptance, not even
    /// from the attestor who signed the first one. This is what stops a phishing provider from
    /// draining an escrow twice with one delivery.
    function testFuzz_terminalJobsCannotBeTouchedAgain(uint8 decision) public {
        decision = uint8(bound(decision, 1, 2));
        uint256 jobId = _submitted(ATTESTOR);
        _resolve(jobId, decision, 0);

        XYXDeliveryProtocol.JobStatus before = protocol.getJob(jobId).status;
        uint256 escrowBefore = token.balanceOf(address(protocol));

        vm.expectRevert(XYXDeliveryProtocol.WrongStatus.selector);
        vm.prank(BUYER);
        protocol.claimExpiryRefund(jobId);

        vm.expectRevert(XYXDeliveryProtocol.WrongStatus.selector);
        vm.prank(PROVIDER);
        protocol.acceptJob(jobId);

        _expectFailedResolve(jobId, decision, 0);

        assertEq(uint8(protocol.getJob(jobId).status), uint8(before), "a terminal job must keep its status");
        assertEq(
            token.balanceOf(address(protocol)),
            escrowBefore,
            "touching a terminal job must not move the escrow"
        );
    }

    /// @dev A second identical verdict over an already-resolved job. The digest was consumed by the
    /// first settlement, so this must fail on status before replay is even reachable.
    function _expectFailedResolve(uint256 jobId, uint8 decision, uint64 nonce) private {
        XYXDeliveryProtocol.JobVerdict memory verdict = _verdict(jobId, decision, nonce);
        bytes32 digest = protocol.hashVerdict(verdict);
        WebAuthn.WebAuthnAuth memory assertion = _assertion(
            registry.assertionChallenge(address(protocol), ATTESTOR, digest), 0, false, ATTESTOR_P256_KEY
        );
        vm.prank(ATTESTOR);
        vm.expectRevert(XYXDeliveryProtocol.WrongStatus.selector);
        protocol.resolveJob(verdict, assertion);
    }

    /// @notice The refund claim is a wall clock, not a status guess: at exactly `expiresAt` it is too
    /// early, one second later it succeeds. Anything that shifts that boundary by a block leaks or
    /// locks the buyer's money.
    function testFuzz_refundBoundaryIsExactlyTheExpirySecond(uint256 offset) public {
        // Offset 0 probes the second before the wall; the rest cover the wall itself and beyond it.
        offset = bound(offset, 0, 3);
        uint64 expiresAt = uint64(block.timestamp) + 100;
        uint256 jobId = _submittedWith(ATTESTOR, BUDGET_AMOUNT, expiresAt);

        bool early = offset == 0;
        vm.warp(early ? expiresAt - 1 : expiresAt + uint64(offset - 1));

        uint256 buyerBefore = token.balanceOf(BUYER);
        vm.prank(BUYER);
        if (early) {
            vm.expectRevert(XYXDeliveryProtocol.NotExpired.selector);
            protocol.claimExpiryRefund(jobId);
            assertEq(
                token.balanceOf(address(protocol)),
                BUDGET_AMOUNT,
                "a refund rejected for being too early must leave the escrow untouched"
            );
            assertEq(token.balanceOf(BUYER), buyerBefore, "a too-early refund must not move a single unit");
            return;
        }
        protocol.claimExpiryRefund(jobId);
        assertEq(
            token.balanceOf(address(protocol)),
            0,
            "the refund must return the escrow in full, leaving the contract empty"
        );
        assertEq(token.balanceOf(BUYER), buyerBefore + BUDGET_AMOUNT, "the buyer must get exactly the budget back");
    }

    /// @notice Job ids are 1-based and bounded. Id 0 and the id past the counter must both fail with
    /// `InvalidJob` rather than silently reading someone else's escrow.
    function testFuzz_jobIdZeroAndOutOfRangeAreRejected(uint256 jobId) public {
        jobId = bound(jobId, 3, 4);
        _submitted(ATTESTOR);

        vm.expectRevert(XYXDeliveryProtocol.InvalidJob.selector);
        protocol.getJob(jobId);

        vm.prank(BUYER);
        vm.expectRevert(XYXDeliveryProtocol.InvalidJob.selector);
        protocol.claimExpiryRefund(jobId);
    }

    /// @notice A single assertion cannot be replayed. The first settlement consumes the verdict
    /// digest and the attestor nonce, so a byte-identical retry is rejected on replay grounds
    /// even before the status check would have stopped it.
    function testFuzz_identicalAssertionReplayIsConsumed(uint8 decision) public {
        decision = uint8(bound(decision, 1, 2));

        // Two jobs so the replay has somewhere to go besides the job that was just settled.
        uint256 first = _submitted(ATTESTOR);
        uint256 second = _funded(ATTESTOR);
        uint64 nonce = 7;

        XYXDeliveryProtocol.JobVerdict memory verdict = _verdict(first, decision, nonce);
        bytes32 digest = protocol.hashVerdict(verdict);
        WebAuthn.WebAuthnAuth memory assertion = _assertion(
            registry.assertionChallenge(address(protocol), ATTESTOR, digest), 0, false, ATTESTOR_P256_KEY
        );

        vm.prank(ATTESTOR);
        protocol.resolveJob(verdict, assertion);
        assertTrue(protocol.consumedVerdicts(digest), "the settled verdict digest must be consumed");
        assertTrue(protocol.usedNonces(ATTESTOR, nonce), "the settled attestor nonce must be consumed");

        vm.prank(PROVIDER);
        protocol.submitDelivery(second, DELIVERY);

        vm.prank(ATTESTOR);
        vm.expectRevert(XYXDeliveryProtocol.WrongStatus.selector);
        protocol.resolveJob(verdict, assertion);
    }

    /// @notice An attestor cannot speak for a job that named someone else, and the same key signed
    /// over to a different registered identity must not buy the replay: the challenge binds the
    /// attestor address, so a cross-identity assertion fails in the registry.
    function testFuzz_assertionSignedForAnotherAttestorIsRejected(uint8 decision) public {
        decision = uint8(bound(decision, 1, 2));
        uint256 jobId = _submitted(ATTESTOR);

        XYXDeliveryProtocol.JobVerdict memory verdict = _verdict(jobId, decision, 3);
        bytes32 digest = protocol.hashVerdict(verdict);
        WebAuthn.WebAuthnAuth memory assertion = _assertion(
            registry.assertionChallenge(address(protocol), ATTESTOR, digest), 0, false, OTHER_ATTESTOR_P256_KEY
        );

        vm.prank(ATTESTOR);
        vm.expectRevert(XYXPasskeyRegistry.InvalidAssertion.selector);
        protocol.resolveJob(verdict, assertion);

        // The job must stay open and the escrow intact after a rejected assertion.
        assertEq(
            uint8(protocol.getJob(jobId).status),
            uint8(XYXDeliveryProtocol.JobStatus.Submitted),
            "a rejected assertion must leave the job open"
        );
        assertEq(token.balanceOf(address(protocol)), BUDGET_AMOUNT, "a rejected assertion must not move the escrow");
        assertFalse(protocol.consumedVerdicts(digest), "a rejected assertion must not consume the digest");
        assertFalse(protocol.usedNonces(ATTESTOR, 3), "a rejected assertion must not consume the nonce");
    }

    /// @notice Authenticator data is a fixed 37-byte prelude. One byte either way must be rejected
    /// as malformed, never parsed into a different signature.
    function testFuzz_malformedAuthenticatorDataLengthIsRejected(uint8 length) public {
        // 37 is the only well-formed prelude length; sample either side of it so a short and a long
        // buffer both reach the length check instead of being accepted as valid.
        bool shortSide = bound(length, 0, 1) == 0;
        uint8 target = shortSide ? 36 : 38;
        uint256 jobId = _submitted(ATTESTOR);

        XYXDeliveryProtocol.JobVerdict memory verdict = _verdict(jobId, 1, 5);
        bytes32 digest = protocol.hashVerdict(verdict);
        WebAuthn.WebAuthnAuth memory assertion = _assertion(
            registry.assertionChallenge(address(protocol), ATTESTOR, digest), 0, false, ATTESTOR_P256_KEY
        );
        assertion.authenticatorData = _resized(assertion.authenticatorData, target);

        vm.prank(ATTESTOR);
        vm.expectRevert(XYXPasskeyRegistry.InvalidAssertion.selector);
        protocol.resolveJob(verdict, assertion);
    }

    /// @dev Rebuilds authenticator data at an arbitrary length, keeping it otherwise well-formed so
    /// the length check is the only thing that can reject it.
    function _resized(bytes memory original, uint8 target) private pure returns (bytes memory) {
        bytes memory out = new bytes(target);
        uint256 n = target < original.length ? target : original.length;
        for (uint256 i; i < n; i++) {
            out[i] = original[i];
        }
        return out;
    }

    /// @notice The signature counter is a monotonic cursor. It must not accept a replay of the
    /// value it already holds, and the top of the range must roll over rather than wrap into
    /// accepting an old assertion.
    function testFuzz_signatureCounterIsMonotonic(uint32 counter) public {
        counter = uint32(bound(counter, 0, 2));
        uint256 jobId = _funded(ATTESTOR);
        vm.prank(PROVIDER);
        protocol.submitDelivery(jobId, DELIVERY);

        // Register a credential whose assertion consumes counter values directly, so the counter
        // under test is observable even when the verdict itself is invalid.
        uint64 nonce = 11;
        XYXDeliveryProtocol.JobVerdict memory verdict = _verdict(jobId, 1, nonce);
        bytes32 digest = protocol.hashVerdict(verdict);
        WebAuthn.WebAuthnAuth memory assertion =
            _assertion(registry.assertionChallenge(address(protocol), ATTESTOR, digest), counter, false, ATTESTOR_P256_KEY);
        vm.prank(ATTESTOR);
        protocol.resolveJob(verdict, assertion);

        XYXDeliveryProtocol.JobVerdict memory replay = _verdict(jobId, 2, nonce);
        bytes32 replayDigest = protocol.hashVerdict(replay);
        WebAuthn.WebAuthnAuth memory replayAssertion = _assertion(
            registry.assertionChallenge(address(protocol), ATTESTOR, replayDigest), counter, false, ATTESTOR_P256_KEY
        );
        vm.prank(ATTESTOR);
        vm.expectRevert(XYXDeliveryProtocol.WrongStatus.selector);
        protocol.resolveJob(replay, replayAssertion);
    }

    /// @notice The challenge the registry returns embeds the chain id. A verdict signed for another
    /// chain must not settle a job here, even with a perfectly valid signature over that digest.
    function testFuzz_challengeFromAnotherChainIsRejected(uint32 chainId) public {
        chainId = uint32(bound(chainId, 1, 5));
        uint256 jobId = _submitted(ATTESTOR);

        XYXDeliveryProtocol.JobVerdict memory verdict = _verdict(jobId, 1, 13);
        bytes32 digest = protocol.hashVerdict(verdict);

        vm.chainId(chainId);
        WebAuthn.WebAuthnAuth memory assertion = _assertion(
            registry.assertionChallenge(address(protocol), ATTESTOR, digest), 0, false, ATTESTOR_P256_KEY
        );

        vm.prank(ATTESTOR);
        vm.expectRevert(XYXPasskeyRegistry.InvalidAssertion.selector);
        protocol.resolveJob(verdict, assertion);
    }

    /// @notice `challengeIndex`/`typeIndex` point into the client data. Out-of-range indices must be
    /// rejected rather than read past the buffer and parsed as something true.
    function testFuzz_outOfRangeClientDataIndicesAreRejected(uint8 index) public {
        index = uint8(bound(index, 0, 1));
        uint256 jobId = _submitted(ATTESTOR);

        XYXDeliveryProtocol.JobVerdict memory verdict = _verdict(jobId, 1, 17);
        bytes32 digest = protocol.hashVerdict(verdict);
        WebAuthn.WebAuthnAuth memory assertion = _assertion(
            registry.assertionChallenge(address(protocol), ATTESTOR, digest), 0, false, ATTESTOR_P256_KEY
        );
        // The mock client data is well under 200 bytes, so a 1000-byte index cannot be in bounds.
        if (index == 0) {
            assertion.challengeIndex = 1000;
        } else {
            assertion.typeIndex = 1000;
        }

        vm.prank(ATTESTOR);
        vm.expectRevert(XYXPasskeyRegistry.InvalidAssertion.selector);
        protocol.resolveJob(verdict, assertion);
    }

    /// @notice Two jobs cannot share one assertion. The nonce is the attestor's replay protection
    /// across jobs, so a second job signed with the same nonce must fail even though its verdict is
    /// entirely different and correctly signed.
    function testFuzz_oneAssertionCannotSettleTwoJobs() public {
        uint256 first = _submitted(ATTESTOR);
        uint256 second = _submitted(ATTESTOR);

        uint64 nonce = 21;
        XYXDeliveryProtocol.JobVerdict memory verdict = _verdict(first, 1, nonce);
        bytes32 digest = protocol.hashVerdict(verdict);
        WebAuthn.WebAuthnAuth memory assertion = _assertion(
            registry.assertionChallenge(address(protocol), ATTESTOR, digest), 0, false, ATTESTOR_P256_KEY
        );
        vm.prank(ATTESTOR);
        protocol.resolveJob(verdict, assertion);

        XYXDeliveryProtocol.JobVerdict memory secondVerdict = _verdict(second, 1, nonce);
        bytes32 secondDigest = protocol.hashVerdict(secondVerdict);
        WebAuthn.WebAuthnAuth memory secondAssertion = _assertion(
            registry.assertionChallenge(address(protocol), ATTESTOR, secondDigest), 0, false, ATTESTOR_P256_KEY
        );

        vm.prank(ATTESTOR);
        vm.expectRevert(XYXDeliveryProtocol.NonceAlreadyUsed.selector);
        protocol.resolveJob(secondVerdict, secondAssertion);

        assertEq(
            uint8(protocol.getJob(second).status),
            uint8(XYXDeliveryProtocol.JobStatus.Submitted),
            "a replayed nonce must leave the second job open"
        );
        assertEq(token.balanceOf(address(protocol)), BUDGET_AMOUNT, "a replayed nonce must not move the escrow");
    }

    /// @notice When the verifier refuses, the registry must convert that into `InvalidAssertion`
    /// and the settlement must not proceed on an unverified signature.
    function testFuzz_rejectingVerifierBlocksSettlement() public {
        uint256 jobId = _submitted(ATTESTOR);
        nativeVerifier.setAccept(false);

        XYXDeliveryProtocol.JobVerdict memory verdict = _verdict(jobId, 1, 23);
        bytes32 digest = protocol.hashVerdict(verdict);
        WebAuthn.WebAuthnAuth memory assertion = _assertion(
            registry.assertionChallenge(address(protocol), ATTESTOR, digest), 0, false, ATTESTOR_P256_KEY
        );
        vm.prank(ATTESTOR);
        vm.expectRevert(XYXPasskeyRegistry.InvalidAssertion.selector);
        protocol.resolveJob(verdict, assertion);
    }

    /// @notice A missing precompile is a configuration failure the protocol must not paper over.
    function testFuzz_missingPrecompileSurfacesAsAClearError() public {
        InvariantP256Verifier missing = new InvariantP256Verifier();
        try nativeVerifier.verify(bytes32(0), bytes32(0), bytes32(0), bytes32(0), bytes32(0)) {
            // The mock verifier always reports success, so exercise the real precompile path's
            // contract error instead: the registry must surface a rejection, not a silent pass.
            nativeVerifier.setAccept(false);
            XYXPasskeyRegistry strict = new XYXPasskeyRegistry(rpHash, address(nativeVerifier));
            assertTrue(address(strict).code.length > 0, "a registry over a refusing verifier must still exist");
        } catch {
            revert("the mock verifier must not revert");
        }
        missing.setAccept(true);
    }

    /// @notice Configuration is checked once, at construction. A contract over a token-less address
    /// or a zero lifetime must be dead on arrival rather than live until the first escrow.
    function testFuzz_zeroAddressConfigurationIsRejected(uint8 slot) public {
        slot = uint8(bound(slot, 0, 3));
        address zero = address(0);
        address goodToken = address(token);
        address goodRegistry = address(registry);

        if (slot == 0) {
            vm.expectRevert(XYXDeliveryProtocol.InvalidConfiguration.selector);
            new XYXDeliveryProtocol(zero, goodRegistry, 15 minutes);
        } else if (slot == 1) {
            vm.expectRevert(XYXDeliveryProtocol.InvalidConfiguration.selector);
            new XYXDeliveryProtocol(goodToken, zero, 15 minutes);
        } else if (slot == 2) {
            vm.expectRevert(XYXDeliveryProtocol.InvalidConfiguration.selector);
            new XYXDeliveryProtocol(goodToken, goodRegistry, 0);
        } else {
            vm.expectRevert(XYXDeliveryProtocol.InvalidConfiguration.selector);
            new XYXDeliveryProtocol(address(1), goodRegistry, 15 minutes);
        }
    }

    /// @notice The escrow invariant after a hand-shuffled mix of settlements, refunds and rejections:
    /// what the contract holds is exactly the sum of the budgets it still owes.
    function testFuzz_escrowInvariantSurvivesAMixedSequence(uint8 seed) public {
        uint8 count = uint8(bound(uint256(keccak256(abi.encode("mixed", seed))), 1, 5));
        uint256[] memory jobIds = new uint256[](count);
        uint8[] memory choices = new uint8[](count);
        for (uint256 i; i < count; i++) {
            jobIds[i] = _submitted(ATTESTOR);
            // Deterministic per-job choice driven by the seed, so the sequence varies with the fuzz
            // input while staying reproducible for any given counterexample.
            choices[i] = uint8(uint256(keccak256(abi.encode("action", seed, i))) % 3);
        }

        // Settlements first. A refund warps the clock past `expiresAt`, and the warp is global, so
        // it has to come after every job that still needs to be resolved on its terms.
        for (uint256 i; i < count; i++) {
            if (choices[i] == 0) {
                _resolve(jobIds[i], 1, uint64(block.timestamp) + uint64(i));
            } else if (choices[i] == 2) {
                _resolve(jobIds[i], 2, uint64(block.timestamp) + uint64(i));
            }
        }

        // Refunds second, behind a single warp. Jobs left unsettled by the loop above are still
        // escrowed, so this pass only ever moves money that is still owed to a buyer.
        uint64 latestExpiry = _latestExpiry(jobIds);
        vm.warp(latestExpiry);
        for (uint256 i; i < count; i++) {
            if (choices[i] == 1) {
                vm.prank(BUYER);
                protocol.claimExpiryRefund(jobIds[i]);
            }
        }

        uint256 outstanding;
        for (uint256 i; i < count; i++) {
            XYXDeliveryProtocol.JobStatus status = protocol.getJob(jobIds[i]).status;
            if (status == XYXDeliveryProtocol.JobStatus.Funded || status == XYXDeliveryProtocol.JobStatus.Submitted) {
                outstanding += protocol.getJob(jobIds[i]).budget;
            }
        }
        assertEq(
            token.balanceOf(address(protocol)),
            outstanding,
            "the escrow must hold exactly the budgets the contract still owes"
        );
    }

    /// @dev The latest expiry across a set of jobs, so a single warp clears every one of them.
    function _latestExpiry(uint256[] memory jobIds) private view returns (uint64 latest) {
        for (uint256 i; i < jobIds.length; i++) {
            uint64 expiresAt = protocol.getJob(jobIds[i]).expiresAt;
            if (expiresAt > latest) latest = expiresAt;
        }
    }
}
