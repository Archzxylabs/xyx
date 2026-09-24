// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {WebAuthn} from "@openzeppelin/contracts/utils/cryptography/WebAuthn.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {IP256Verifier} from "../src/interfaces/IP256Verifier.sol";
import {XYXPasskeyRegistry} from "../src/XYXPasskeyRegistry.sol";
import {XYXDeliveryProtocol} from "../src/XYXDeliveryProtocol.sol";

/// @notice Production-style P256 verifier that the tests can flip for negative-path checks.
contract SecurityTestP256Verifier is IP256Verifier {
    bool public accept = true;
    function setAccept(bool value) external { accept = value; }
    function verify(bytes32, bytes32, bytes32, bytes32, bytes32) external view returns (bool) {
        return accept;
    }
}

/// @notice transferFrom works normally; transfer returns false unless failSettlement is set.
contract SecurityTestFailingToken is ERC20 {
    bool public failSettlement;
    bool public failTransferFrom;
    constructor() ERC20("Fail Token", "FLT") {}
    function decimals() public pure override returns (uint8) { return 6; }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
    function setFailSettlement(bool _fail) external { failSettlement = _fail; }
    function setFailTransferFrom(bool _fail) external { failTransferFrom = _fail; }
    function transferFrom(address sender, address recipient, uint256 amount) public override returns (bool) {
        if (failTransferFrom) return false;
        _spendAllowance(sender, msg.sender, amount);
        _transfer(sender, recipient, amount);
        return true;
    }
    function transfer(address to, uint256 amount) public override returns (bool) {
        if (failSettlement) return false;
        _transfer(msg.sender, to, amount);
        return true;
    }
}

/// @notice Additional security tests for XYXDeliveryProtocol: token failures, replay guards,
/// altered commitment values, and early-expiry edge cases.
contract XYXDeliveryProtocolSecurityTest is Test {
    uint256 private constant ATTESTOR_P256_KEY = 0xA771E570;
    address private constant BUYER = address(0xB0B);
    address private constant PROVIDER = address(0xBEEF);
    address private constant ATTESTOR = address(0xA771E570);
    address private constant FAKE_ATTESTOR = address(0xFACE);
    uint256 private constant BUDGET = 20_000;

    bytes32 private constant TERMS = keccak256("private terms commitment");
    bytes32 private constant DELIVERY = keccak256("private delivery commitment");
    bytes32 private constant EVIDENCE = keccak256("private evidence commitment");
    bytes32 private constant REASON = keccak256("private reason commitment");

    SecurityTestFailingToken private failingToken;

    XYXDeliveryProtocol private failingProtocol;

    XYXPasskeyRegistry private failingRegistry;
    SecurityTestP256Verifier private nativeVerifier;
    bytes32 private rpHash;
    bytes32 private attestorQx;
    bytes32 private attestorQy;

    // --- Boilerplate shared with XYXDeliveryProtocolTest ---

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

    function _registerAttestor(
        XYXPasskeyRegistry registry,
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

    function _propose(XYXDeliveryProtocol protocol, address attestor) private returns (uint256 jobId) {
        vm.prank(BUYER);
        jobId = protocol.proposeJob(PROVIDER, attestor, TERMS, BUDGET, uint64(block.timestamp + 1 hours));
    }

    function _fundAndSubmit(XYXDeliveryProtocol protocol, address attestor) private returns (uint256 jobId) {
        jobId = _propose(protocol, attestor);
        vm.prank(PROVIDER);
        protocol.acceptJob(jobId);
        vm.prank(BUYER);
        protocol.fundJob(jobId);
        vm.prank(PROVIDER);
        protocol.submitDelivery(jobId, DELIVERY);
    }

    // --- Setups ---

    function setUp() public {
        vm.chainId(10143);
        rpHash = sha256(bytes("xyx.local"));
        nativeVerifier = new SecurityTestP256Verifier();

        (uint256 qx, uint256 qy) = vm.publicKeyP256(ATTESTOR_P256_KEY);
        attestorQx = bytes32(qx);
        attestorQy = bytes32(qy);
    }

    function _setupFailing() private {
        failingToken = new SecurityTestFailingToken();
        failingRegistry = new XYXPasskeyRegistry(rpHash, address(nativeVerifier));
        failingProtocol = new XYXDeliveryProtocol(address(failingToken), address(failingRegistry), 15 minutes);

        failingToken.mint(BUYER, 1_000_000);
        vm.prank(BUYER);
        failingToken.approve(address(failingProtocol), type(uint256).max);

        _registerAttestor(failingRegistry, ATTESTOR, keccak256("attestor credential"), attestorQx, attestorQy, ATTESTOR_P256_KEY);
    }

    // ============================================
    // TOKEN REVERT ON RESOLVE — NO DIGEST/NONCE BURN
    // ============================================

    function testTokenRevertOnResolveDoesNotConsumeDigestOrNonce() public {
        _setupFailing();
        uint256 jobId = _fundAndSubmit(failingProtocol, ATTESTOR);
        XYXDeliveryProtocol.JobVerdict memory verdict = _verdict(jobId, 1, 7);
        bytes32 digest = failingProtocol.hashVerdict(verdict);
        WebAuthn.WebAuthnAuth memory assertion = _assertion(
            failingRegistry.assertionChallenge(address(failingProtocol), ATTESTOR, digest), 1, false, ATTESTOR_P256_KEY
        );

        failingToken.setFailSettlement(true);
        vm.prank(ATTESTOR);
        vm.expectRevert();
        failingProtocol.resolveJob(verdict, assertion);

        assertFalse(failingProtocol.consumedVerdicts(digest));
        assertFalse(failingProtocol.usedNonces(ATTESTOR, 7));
        assertEq(uint256(failingProtocol.getJob(jobId).status), uint256(XYXDeliveryProtocol.JobStatus.Submitted));
        assertEq(failingToken.balanceOf(address(failingProtocol)), BUDGET);
    }

    // ============================================
    // TOKEN REVERT ON EXPIRY REFUND — NO STATUS CHANGE
    // ============================================

    function testTokenRevertOnExpiryRefundDoesNotChangeStatus() public {
        _setupFailing();
        uint256 jobId = _propose(failingProtocol, ATTESTOR);
        vm.prank(PROVIDER);
        failingProtocol.acceptJob(jobId);
        vm.prank(BUYER);
        failingProtocol.fundJob(jobId);

        vm.warp(failingProtocol.getJob(jobId).expiresAt);

        failingToken.setFailSettlement(true);
        vm.expectRevert();
        failingProtocol.claimExpiryRefund(jobId);

        assertEq(uint256(failingProtocol.getJob(jobId).status), uint256(XYXDeliveryProtocol.JobStatus.Funded));
        assertEq(failingToken.balanceOf(address(failingProtocol)), BUDGET);
    }

    // ============================================
    // TOKEN FALSE-RETURN ON FUND — NO STATUS CHANGE
    // ============================================

    function testTokenFalseReturnOnFundDoesNotChangeStatus() public {
        _setupFailing();
        uint256 jobId = _propose(failingProtocol, ATTESTOR);
        vm.prank(PROVIDER);
        failingProtocol.acceptJob(jobId);

        failingToken.setFailTransferFrom(true);
        vm.prank(BUYER);
        vm.expectRevert();
        failingProtocol.fundJob(jobId);

        assertEq(uint256(failingProtocol.getJob(jobId).status), uint256(XYXDeliveryProtocol.JobStatus.Accepted));
        assertEq(failingToken.balanceOf(address(failingProtocol)), 0);
    }

    // ============================================
    // REENTRANCY GUARD ON resolveJob — SECOND FRESH CALL SUCCEEDS
    // ============================================

    function testReentrancyGuardReleasesAfterResolveReturns() public {
        _setupFailing();

        // First job resolves successfully, consuming nonce 7.
        uint256 jobId = _fundAndSubmit(failingProtocol, ATTESTOR);
        XYXDeliveryProtocol.JobVerdict memory verdict = _verdict(jobId, 1, 7);
        bytes32 digest = failingProtocol.hashVerdict(verdict);
        WebAuthn.WebAuthnAuth memory assertion = _assertion(
            failingRegistry.assertionChallenge(address(failingProtocol), ATTESTOR, digest), 1, false, ATTESTOR_P256_KEY
        );
        vm.prank(ATTESTOR);
        failingProtocol.resolveJob(verdict, assertion);
        assertEq(uint256(failingProtocol.getJob(jobId).status), uint256(XYXDeliveryProtocol.JobStatus.Completed));

        // A second job resolves with a different nonce — guard released.
        uint256 jobId2 = _fundAndSubmit(failingProtocol, ATTESTOR);
        XYXDeliveryProtocol.JobVerdict memory verdict2 = _verdict(jobId2, 1, 99);
        bytes32 digest2 = failingProtocol.hashVerdict(verdict2);
        WebAuthn.WebAuthnAuth memory assertion2 = _assertion(
            failingRegistry.assertionChallenge(address(failingProtocol), ATTESTOR, digest2), 99, false, ATTESTOR_P256_KEY
        );
        vm.prank(ATTESTOR);
        failingProtocol.resolveJob(verdict2, assertion2);
        assertEq(uint256(failingProtocol.getJob(jobId2).status), uint256(XYXDeliveryProtocol.JobStatus.Completed));
    }

    function testReentrancyGuardReleasesAfterExpiryRefundReturns() public {
        _setupFailing();

        uint256 jobId = _propose(failingProtocol, ATTESTOR);
        vm.prank(PROVIDER);
        failingProtocol.acceptJob(jobId);
        vm.prank(BUYER);
        failingProtocol.fundJob(jobId);

        vm.warp(failingProtocol.getJob(jobId).expiresAt);
        failingProtocol.claimExpiryRefund(jobId);
        assertEq(uint256(failingProtocol.getJob(jobId).status), uint256(XYXDeliveryProtocol.JobStatus.Expired));

        // Second job's expiry refund succeeds (guard released).
        uint256 jobId2 = _propose(failingProtocol, ATTESTOR);
        vm.prank(PROVIDER);
        failingProtocol.acceptJob(jobId2);
        vm.prank(BUYER);
        failingProtocol.fundJob(jobId2);
        vm.warp(failingProtocol.getJob(jobId2).expiresAt);
        failingProtocol.claimExpiryRefund(jobId2);
        assertEq(uint256(failingProtocol.getJob(jobId2).status), uint256(XYXDeliveryProtocol.JobStatus.Expired));
    }

    // ============================================
    // TOKEN REVERT GUARDS PROVE CHECK-EFFECTS-INTERACTIONS
    // ============================================

    // ============================================
    // EARLY EXPIRY REFUND IS REJECTED
    // ============================================

    function testExpiryRefundRevertsBeforeExpiry() public {
        _setupFailing();
        uint256 jobId = _propose(failingProtocol, ATTESTOR);
        vm.prank(PROVIDER);
        failingProtocol.acceptJob(jobId);
        vm.prank(BUYER);
        failingProtocol.fundJob(jobId);

        vm.expectRevert(XYXDeliveryProtocol.NotExpired.selector);
        failingProtocol.claimExpiryRefund(jobId);

        assertEq(uint256(failingProtocol.getJob(jobId).status), uint256(XYXDeliveryProtocol.JobStatus.Funded));
        assertEq(failingToken.balanceOf(address(failingProtocol)), BUDGET);
    }

    // ============================================
    // UNAUTHORIZED SUBMIT/RESOLVE ATTEMPTS
    // ============================================

    function testUnauthorizedProviderCannotResolve() public {
        _setupFailing();
        uint256 jobId = _fundAndSubmit(failingProtocol, ATTESTOR);
        XYXDeliveryProtocol.JobVerdict memory verdict = _verdict(jobId, 1, 11);
        bytes32 digest = failingProtocol.hashVerdict(verdict);
        WebAuthn.WebAuthnAuth memory assertion = _assertion(
            failingRegistry.assertionChallenge(address(failingProtocol), ATTESTOR, digest), 1, false, ATTESTOR_P256_KEY
        );

        vm.prank(PROVIDER);
        vm.expectRevert(XYXDeliveryProtocol.Unauthorized.selector);
        failingProtocol.resolveJob(verdict, assertion);

        assertFalse(failingProtocol.consumedVerdicts(digest));
        assertFalse(failingProtocol.usedNonces(ATTESTOR, 11));
    }

    function testUnauthorizedBuyerCannotSubmit() public {
        _setupFailing();
        uint256 jobId = _propose(failingProtocol, ATTESTOR);
        vm.prank(PROVIDER);
        failingProtocol.acceptJob(jobId);
        vm.prank(BUYER);
        failingProtocol.fundJob(jobId);

        vm.prank(BUYER);
        vm.expectRevert(XYXDeliveryProtocol.Unauthorized.selector);
        failingProtocol.submitDelivery(jobId, DELIVERY);
    }

    function testOtherAttestorCannotResolve() public {
        _setupFailing();
        uint256 jobId = _fundAndSubmit(failingProtocol, ATTESTOR);
        XYXDeliveryProtocol.JobVerdict memory verdict = _verdict(jobId, 1, 12);
        bytes32 digest = failingProtocol.hashVerdict(verdict);
        WebAuthn.WebAuthnAuth memory assertion = _assertion(
            failingRegistry.assertionChallenge(address(failingProtocol), ATTESTOR, digest), 1, false, ATTESTOR_P256_KEY
        );

        vm.prank(FAKE_ATTESTOR);
        vm.expectRevert(XYXDeliveryProtocol.Unauthorized.selector);
        failingProtocol.resolveJob(verdict, assertion);

        assertFalse(failingProtocol.consumedVerdicts(digest));
        assertFalse(failingProtocol.usedNonces(ATTESTOR, 12));
    }

    // ============================================
    // EXACT PAYMENT RECIPIENTS
    // ============================================

    function testCompleteSendsBudgetToProviderAndNotBuyer() public {
        _setupFailing();
        uint256 jobId = _fundAndSubmit(failingProtocol, ATTESTOR);
        uint256 buyerBefore = failingToken.balanceOf(BUYER);
        uint256 providerBefore = failingToken.balanceOf(PROVIDER);

        XYXDeliveryProtocol.JobVerdict memory verdict = _verdict(jobId, 1, 13);
        bytes32 digest = failingProtocol.hashVerdict(verdict);
        WebAuthn.WebAuthnAuth memory assertion = _assertion(
            failingRegistry.assertionChallenge(address(failingProtocol), ATTESTOR, digest), 1, false, ATTESTOR_P256_KEY
        );

        vm.prank(ATTESTOR);
        failingProtocol.resolveJob(verdict, assertion);

        assertEq(failingToken.balanceOf(PROVIDER), providerBefore + BUDGET);
        assertEq(failingToken.balanceOf(BUYER), buyerBefore);
        assertEq(failingToken.balanceOf(address(failingProtocol)), 0);
    }

    function testRejectSendsBudgetToBuyerAndNotProvider() public {
        _setupFailing();
        uint256 jobId = _fundAndSubmit(failingProtocol, ATTESTOR);
        uint256 buyerBefore = failingToken.balanceOf(BUYER);
        uint256 providerBefore = failingToken.balanceOf(PROVIDER);

        XYXDeliveryProtocol.JobVerdict memory verdict = _verdict(jobId, 2, 14);
        bytes32 digest = failingProtocol.hashVerdict(verdict);
        WebAuthn.WebAuthnAuth memory assertion = _assertion(
            failingRegistry.assertionChallenge(address(failingProtocol), ATTESTOR, digest), 1, false, ATTESTOR_P256_KEY
        );

        vm.prank(ATTESTOR);
        failingProtocol.resolveJob(verdict, assertion);

        assertEq(failingToken.balanceOf(BUYER), buyerBefore + BUDGET);
        assertEq(failingToken.balanceOf(PROVIDER), providerBefore);
        assertEq(failingToken.balanceOf(address(failingProtocol)), 0);
    }

    function testExpiryRefundSendsBudgetToBuyer() public {
        _setupFailing();
        uint256 jobId = _fundAndSubmit(failingProtocol, ATTESTOR);
        uint256 buyerBefore = failingToken.balanceOf(BUYER);

        vm.warp(failingProtocol.getJob(jobId).expiresAt);
        failingProtocol.claimExpiryRefund(jobId);

        assertEq(failingToken.balanceOf(BUYER), buyerBefore + BUDGET);
        assertEq(failingToken.balanceOf(address(failingProtocol)), 0);
    }

    // ============================================
    // NONCE/DIGEST REPLAY PREVENTION
    // ============================================

    function testDigestReplayAfterFailedSettlementIsRejected() public {
        _setupFailing();
        uint256 jobId = _fundAndSubmit(failingProtocol, ATTESTOR);
        XYXDeliveryProtocol.JobVerdict memory verdict = _verdict(jobId, 1, 15);
        bytes32 digest = failingProtocol.hashVerdict(verdict);
        WebAuthn.WebAuthnAuth memory assertion = _assertion(
            failingRegistry.assertionChallenge(address(failingProtocol), ATTESTOR, digest), 1, false, ATTESTOR_P256_KEY
        );

        failingToken.setFailSettlement(true);
        vm.prank(ATTESTOR);
        vm.expectRevert();
        failingProtocol.resolveJob(verdict, assertion);

        assertFalse(failingProtocol.consumedVerdicts(digest));
        assertFalse(failingProtocol.usedNonces(ATTESTOR, 15));

        // Same digest/nonce succeeds once token is fixed.
        failingToken.setFailSettlement(false);
        vm.prank(ATTESTOR);
        failingProtocol.resolveJob(verdict, assertion);

        assertEq(uint256(failingProtocol.getJob(jobId).status), uint256(XYXDeliveryProtocol.JobStatus.Completed));
        assertEq(failingToken.balanceOf(PROVIDER), BUDGET);
    }

    // ============================================
    // EARLY EXPIRY (expiry == block.timestamp boundary)
    // ============================================

    function testExpiryAtExactTimestampAllowsRefund() public {
        _setupFailing();
        uint256 jobId = _propose(failingProtocol, ATTESTOR);
        vm.prank(PROVIDER);
        failingProtocol.acceptJob(jobId);
        vm.prank(BUYER);
        failingProtocol.fundJob(jobId);

        uint64 expiry = failingProtocol.getJob(jobId).expiresAt;
        vm.warp(expiry);
        failingProtocol.claimExpiryRefund(jobId);

        assertEq(uint256(failingProtocol.getJob(jobId).status), uint256(XYXDeliveryProtocol.JobStatus.Expired));
        assertEq(failingToken.balanceOf(BUYER), 1_000_000);
    }

    // ============================================
    // PROOF-OF-RESERVE: delivery cannot be re-submitted
    // ============================================

    function testCannotSubmitSecondDelivery() public {
        _setupFailing();
        uint256 jobId = _propose(failingProtocol, ATTESTOR);
        vm.prank(PROVIDER);
        failingProtocol.acceptJob(jobId);
        vm.prank(BUYER);
        failingProtocol.fundJob(jobId);
        vm.prank(PROVIDER);
        failingProtocol.submitDelivery(jobId, DELIVERY);

        vm.prank(PROVIDER);
        vm.expectRevert(XYXDeliveryProtocol.WrongStatus.selector);
        failingProtocol.submitDelivery(jobId, keccak256("second delivery"));
    }

    // ============================================
    // PROOF-OF-RESERVE: expired job cannot be accepted/funded
    // ============================================

    function testExpiredProposedJobCannotBeAccepted() public {
        _setupFailing();
        uint256 jobId = _propose(failingProtocol, ATTESTOR);
        vm.warp(failingProtocol.getJob(jobId).expiresAt);

        vm.prank(PROVIDER);
        vm.expectRevert(XYXDeliveryProtocol.WrongStatus.selector);
        failingProtocol.acceptJob(jobId);
    }

    function testExpiredAcceptedJobCannotBeFunded() public {
        _setupFailing();
        uint256 jobId = _propose(failingProtocol, ATTESTOR);
        vm.prank(PROVIDER);
        failingProtocol.acceptJob(jobId);
        vm.warp(failingProtocol.getJob(jobId).expiresAt);

        vm.prank(BUYER);
        vm.expectRevert(XYXDeliveryProtocol.WrongStatus.selector);
        failingProtocol.fundJob(jobId);
    }
}
