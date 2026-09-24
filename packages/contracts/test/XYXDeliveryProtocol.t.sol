// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {WebAuthn} from "@openzeppelin/contracts/utils/cryptography/WebAuthn.sol";
import {IP256Verifier} from "../src/interfaces/IP256Verifier.sol";
import {XYXPasskeyRegistry} from "../src/XYXPasskeyRegistry.sol";
import {XYXDeliveryProtocol} from "../src/XYXDeliveryProtocol.sol";

contract DeliveryTestUSDC is ERC20 {
    constructor() ERC20("Delivery Test USDC", "dUSDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address recipient, uint256 amount) external {
        _mint(recipient, amount);
    }
}

/// @dev The production deployment injects MonadP256Verifier. This seam lets the test prove that
/// the registry rejects an assertion when the mandatory native-verifier step rejects it.
contract ConfigurableP256Verifier is IP256Verifier {
    bool public accept = true;

    function setAccept(bool value) external {
        accept = value;
    }

    function verify(bytes32, bytes32, bytes32, bytes32, bytes32) external view returns (bool) {
        return accept;
    }
}

contract XYXDeliveryProtocolTest is Test {
    uint256 private constant ATTESTOR_P256_KEY = 0xA771E570;
    uint256 private constant OTHER_ATTESTOR_P256_KEY = 0xB0B570;
    address private constant BUYER = address(0xB0B);
    address private constant PROVIDER = address(0xBEEF);
    address private constant ATTESTOR = address(0xA771E570);
    address private constant OTHER_ATTESTOR = address(0xB0B570);
    uint256 private constant BUDGET = 20_000;

    bytes32 private constant TERMS = keccak256("private terms commitment");
    bytes32 private constant DELIVERY = keccak256("private delivery commitment");
    bytes32 private constant EVIDENCE = keccak256("private evidence commitment");
    bytes32 private constant REASON = keccak256("private reason commitment");

    DeliveryTestUSDC private token;
    ConfigurableP256Verifier private nativeVerifier;
    XYXPasskeyRegistry private registry;
    XYXDeliveryProtocol private protocol;
    bytes32 private rpHash;
    bytes32 private attestorQx;
    bytes32 private attestorQy;

    function setUp() public {
        vm.chainId(10143);
        rpHash = sha256(bytes("xyx.local"));
        nativeVerifier = new ConfigurableP256Verifier();
        registry = new XYXPasskeyRegistry(rpHash, address(nativeVerifier));
        protocol = new XYXDeliveryProtocol(address(token = new DeliveryTestUSDC()), address(registry), 15 minutes);

        token.mint(BUYER, 1_000_000);
        vm.prank(BUYER);
        token.approve(address(protocol), type(uint256).max);

        (uint256 qx, uint256 qy) = vm.publicKeyP256(ATTESTOR_P256_KEY);
        attestorQx = bytes32(qx);
        attestorQy = bytes32(qy);
        _registerAttestor(ATTESTOR, keccak256("attestor credential"), attestorQx, attestorQy, ATTESTOR_P256_KEY);
    }

    function testProviderMustAcceptBeforeBuyerCanFund() public {
        uint256 jobId = _propose(ATTESTOR);
        vm.prank(BUYER);
        vm.expectRevert(XYXDeliveryProtocol.WrongStatus.selector);
        protocol.fundJob(jobId);
        assertEq(uint256(protocol.getJob(jobId).status), uint256(XYXDeliveryProtocol.JobStatus.Proposed));
        assertEq(token.balanceOf(address(protocol)), 0);
    }

    function testAcceptedJobCompletesWithBoundPasskeyAssertion() public {
        uint256 jobId = _fundAndSubmit(ATTESTOR);
        XYXDeliveryProtocol.JobVerdict memory verdict = _verdict(jobId, 1, 1);
        bytes32 digest = protocol.hashVerdict(verdict);
        WebAuthn.WebAuthnAuth memory assertion = _assertion(
            registry.assertionChallenge(address(protocol), ATTESTOR, digest), 1, false, ATTESTOR_P256_KEY
        );

        vm.prank(ATTESTOR);
        protocol.resolveJob(verdict, assertion);

        assertEq(uint256(protocol.getJob(jobId).status), uint256(XYXDeliveryProtocol.JobStatus.Completed));
        assertEq(token.balanceOf(PROVIDER), BUDGET);
        assertEq(token.balanceOf(address(protocol)), 0);
        assertTrue(protocol.consumedVerdicts(digest));
        assertTrue(protocol.usedNonces(ATTESTOR, 1));
        assertEq(registry.credentialOf(ATTESTOR).signCount, 1);
    }

    function testSelectedAttestorCannotBeReplaced() public {
        uint256 jobId = _fundAndSubmit(ATTESTOR);
        XYXDeliveryProtocol.JobVerdict memory verdict = _verdict(jobId, 1, 2);
        WebAuthn.WebAuthnAuth memory assertion = _assertion(bytes32(uint256(1)), 1, false, ATTESTOR_P256_KEY);

        vm.prank(OTHER_ATTESTOR);
        vm.expectRevert(XYXDeliveryProtocol.Unauthorized.selector);
        protocol.resolveJob(verdict, assertion);
        assertEq(uint256(protocol.getJob(jobId).status), uint256(XYXDeliveryProtocol.JobStatus.Submitted));
    }

    function testRejectRefundsBuyerWithAttestorAssertion() public {
        uint256 jobId = _fundAndSubmit(ATTESTOR);
        XYXDeliveryProtocol.JobVerdict memory verdict = _verdict(jobId, 2, 3);
        bytes32 digest = protocol.hashVerdict(verdict);
        WebAuthn.WebAuthnAuth memory assertion = _assertion(
            registry.assertionChallenge(address(protocol), ATTESTOR, digest), 1, false, ATTESTOR_P256_KEY
        );

        vm.prank(ATTESTOR);
        protocol.resolveJob(verdict, assertion);

        assertEq(uint256(protocol.getJob(jobId).status), uint256(XYXDeliveryProtocol.JobStatus.Rejected));
        assertEq(token.balanceOf(BUYER), 1_000_000);
        assertEq(token.balanceOf(PROVIDER), 0);
    }

    function testExpiryRefundNeedsNoAttestorAndCannotRunEarly() public {
        uint256 jobId = _fundAndSubmit(ATTESTOR);
        vm.expectRevert(XYXDeliveryProtocol.NotExpired.selector);
        protocol.claimExpiryRefund(jobId);

        vm.warp(protocol.getJob(jobId).expiresAt);
        protocol.claimExpiryRefund(jobId);

        assertEq(uint256(protocol.getJob(jobId).status), uint256(XYXDeliveryProtocol.JobStatus.Expired));
        assertEq(token.balanceOf(BUYER), 1_000_000);
    }

    function testAssertionRejectsWrongRpIdHash() public {
        bytes32 action = keccak256("attestor registration proof");
        WebAuthn.WebAuthnAuth memory assertion = _assertion(
            registry.assertionChallenge(address(this), ATTESTOR, action), 1, true, ATTESTOR_P256_KEY
        );

        vm.expectRevert(XYXPasskeyRegistry.InvalidRpIdHash.selector);
        registry.consumeAssertion(ATTESTOR, action, assertion);
    }

    function testAssertionCounterCannotBeReplayedWhenAuthenticatorSupportsIt() public {
        bytes32 firstAction = keccak256("first action");
        WebAuthn.WebAuthnAuth memory first = _assertion(
            registry.assertionChallenge(address(this), ATTESTOR, firstAction), 1, false, ATTESTOR_P256_KEY
        );
        registry.consumeAssertion(ATTESTOR, firstAction, first);

        bytes32 secondAction = keccak256("second action");
        WebAuthn.WebAuthnAuth memory replayedCounter = _assertion(
            registry.assertionChallenge(address(this), ATTESTOR, secondAction), 1, false, ATTESTOR_P256_KEY
        );
        vm.expectRevert(XYXPasskeyRegistry.InvalidSignatureCounter.selector);
        registry.consumeAssertion(ATTESTOR, secondAction, replayedCounter);
    }

    function testAssertionIsBoundToTheProtocolConsumer() public {
        uint256 jobId = _fundAndSubmit(ATTESTOR);
        XYXDeliveryProtocol.JobVerdict memory verdict = _verdict(jobId, 1, 4);
        bytes32 digest = protocol.hashVerdict(verdict);
        WebAuthn.WebAuthnAuth memory assertion = _assertion(
            registry.assertionChallenge(address(protocol), ATTESTOR, digest), 1, false, ATTESTOR_P256_KEY
        );

        vm.expectRevert(XYXPasskeyRegistry.InvalidAssertion.selector);
        registry.consumeAssertion(ATTESTOR, digest, assertion);
        assertEq(uint256(protocol.getJob(jobId).status), uint256(XYXDeliveryProtocol.JobStatus.Submitted));
    }

    function testNativeP256StepMustAcceptTheAssertion() public {
        bytes32 action = keccak256("native verifier action");
        WebAuthn.WebAuthnAuth memory assertion = _assertion(
            registry.assertionChallenge(address(this), ATTESTOR, action), 1, false, ATTESTOR_P256_KEY
        );
        nativeVerifier.setAccept(false);

        vm.expectRevert(XYXPasskeyRegistry.InvalidAssertion.selector);
        registry.consumeAssertion(ATTESTOR, action, assertion);
    }

    function _propose(address attestor) private returns (uint256 jobId) {
        vm.prank(BUYER);
        jobId = protocol.proposeJob(PROVIDER, attestor, TERMS, BUDGET, uint64(block.timestamp + 1 hours));
    }

    function _fundAndSubmit(address attestor) private returns (uint256 jobId) {
        jobId = _propose(attestor);
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
}
