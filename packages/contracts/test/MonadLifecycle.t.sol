// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {AgenticCommerce} from "../src/AgenticCommerce.sol";
import {XYXEvaluator} from "../src/XYXEvaluator.sol";

contract TestUSDC is ERC20 {
    constructor() ERC20("Test USDC", "USDC") {}
    function decimals() public pure override returns (uint8) { return 6; }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

contract MonadLifecycleTest is Test {
    uint256 internal constant SIGNER_KEY = 0xA11CE;
    address internal constant BUYER = address(0xB0B);
    address internal constant PROVIDER = address(0xBEEF);
    TestUSDC internal token;
    AgenticCommerce internal commerce;
    XYXEvaluator internal evaluator;

    function setUp() public {
        vm.chainId(10143);
        token = new TestUSDC();
        commerce = new AgenticCommerce(address(token));
        evaluator = new XYXEvaluator(address(this), vm.addr(SIGNER_KEY), address(this), address(commerce), 300);
        token.mint(BUYER, 1_000_000);
        vm.prank(BUYER);
        token.approve(address(commerce), type(uint256).max);
    }

    function _fundedJob() internal returns (uint256 id) {
        return _fundedJobFor(PROVIDER);
    }

    function _fundedJobFor(address provider) internal returns (uint256 id) {
        vm.prank(BUYER);
        id = commerce.createJob(provider, address(evaluator), block.timestamp + 1 days, "ipfs://spec", address(0));
        vm.prank(provider);
        commerce.setBudget(id, 20_000, "");
        vm.prank(BUYER);
        commerce.fund(id, 20_000, "");
    }

    function _verdict(uint256 id, uint8 decision, uint64 nonce) internal view returns (XYXEvaluator.JobVerdict memory) {
        return XYXEvaluator.JobVerdict(id, keccak256("evidence"), keccak256("reason"), decision,
            uint64(block.timestamp), uint64(block.timestamp + 120), nonce);
    }

    function _sign(XYXEvaluator.JobVerdict memory verdict) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SIGNER_KEY, evaluator.hashVerdict(verdict));
        return abi.encodePacked(r, s, v);
    }

    function testCompleteReleasesEscrowOnce() public {
        uint256 id = _fundedJob();
        vm.prank(PROVIDER);
        commerce.submit(id, keccak256("transfer tx"), "");
        XYXEvaluator.JobVerdict memory verdict = _verdict(id, 1, 1);
        evaluator.resolveJob(verdict, _sign(verdict));
        assertEq(uint256(commerce.getJob(id).status), uint256(AgenticCommerce.JobStatus.Completed));
        assertEq(token.balanceOf(PROVIDER), 20_000);
        assertEq(token.balanceOf(address(commerce)), 0);
        bytes memory signature = _sign(verdict);
        vm.expectRevert(XYXEvaluator.VerdictAlreadyConsumed.selector);
        evaluator.resolveJob(verdict, signature);
    }

    function testRejectRefundsBuyer() public {
        uint256 id = _fundedJob();
        vm.prank(PROVIDER);
        commerce.submit(id, keccak256("wrong transfer tx"), "");
        XYXEvaluator.JobVerdict memory verdict = _verdict(id, 2, 2);
        evaluator.resolveJob(verdict, _sign(verdict));
        assertEq(uint256(commerce.getJob(id).status), uint256(AgenticCommerce.JobStatus.Rejected));
        assertEq(token.balanceOf(BUYER), 1_000_000);
        assertEq(token.balanceOf(PROVIDER), 0);
    }

    function testExpiryRefundsBuyer() public {
        uint256 id = _fundedJob();
        vm.warp(block.timestamp + 1 days);
        commerce.claimRefund(id);
        assertEq(uint256(commerce.getJob(id).status), uint256(AgenticCommerce.JobStatus.Expired));
        assertEq(token.balanceOf(BUYER), 1_000_000);
    }

    function testCannotSettleWithoutProviderSubmission() public {
        uint256 id = _fundedJob();
        XYXEvaluator.JobVerdict memory verdict = _verdict(id, 1, 3);
        bytes memory signature = _sign(verdict);
        vm.expectRevert(AgenticCommerce.WrongStatus.selector);
        evaluator.resolveJob(verdict, signature);
        assertFalse(evaluator.consumed(evaluator.hashVerdict(verdict)));
        assertEq(token.balanceOf(address(commerce)), 20_000);
    }

    function testOnlyProviderCanSubmitAndOnlyBuyerCanFund() public {
        vm.prank(BUYER);
        uint256 id = commerce.createJob(PROVIDER, address(evaluator), block.timestamp + 1 days, "ipfs://spec", address(0));
        vm.prank(PROVIDER);
        commerce.setBudget(id, 20_000, "");
        vm.prank(PROVIDER);
        vm.expectRevert(AgenticCommerce.Unauthorized.selector);
        commerce.fund(id, 20_000, "");
        vm.prank(BUYER);
        commerce.fund(id, 20_000, "");
        vm.prank(BUYER);
        vm.expectRevert(AgenticCommerce.Unauthorized.selector);
        commerce.submit(id, keccak256("transfer tx"), "");
    }

    function testBudgetCannotChangeAfterFunding() public {
        uint256 id = _fundedJob();
        vm.prank(PROVIDER);
        vm.expectRevert(AgenticCommerce.WrongStatus.selector);
        commerce.setBudget(id, 10_000, "");
    }

    function testWrongSignerCannotResolve() public {
        uint256 id = _fundedJob();
        vm.prank(PROVIDER);
        commerce.submit(id, keccak256("transfer tx"), "");
        XYXEvaluator.JobVerdict memory verdict = _verdict(id, 1, 4);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0xBAD, evaluator.hashVerdict(verdict));
        bytes memory signature = abi.encodePacked(r, s, v);
        vm.expectRevert();
        evaluator.resolveJob(verdict, signature);
        assertEq(token.balanceOf(address(commerce)), 20_000);
    }

    function testSignatureCannotCrossChains() public {
        uint256 id = _fundedJob();
        vm.prank(PROVIDER);
        commerce.submit(id, keccak256("transfer tx"), "");
        XYXEvaluator.JobVerdict memory verdict = _verdict(id, 1, 5);
        bytes memory signature = _sign(verdict);
        vm.chainId(143);
        vm.expectRevert();
        evaluator.resolveJob(verdict, signature);
        assertEq(token.balanceOf(address(commerce)), 20_000);
    }

    function testExpiredJobCannotBeCompleted() public {
        uint256 id = _fundedJob();
        vm.prank(PROVIDER);
        commerce.submit(id, keccak256("transfer tx"), "");
        vm.warp(block.timestamp + 1 days);
        XYXEvaluator.JobVerdict memory verdict = _verdict(id, 1, 6);
        bytes memory signature = _sign(verdict);
        vm.expectRevert(AgenticCommerce.WrongStatus.selector);
        evaluator.resolveJob(verdict, signature);
        commerce.claimRefund(id);
        assertEq(token.balanceOf(BUYER), 1_000_000);
    }

    function testExpiredJobCannotBeRejectedAndUsesRefundTerminalState() public {
        uint256 id = _fundedJob();
        vm.prank(PROVIDER);
        commerce.submit(id, keccak256("transfer tx"), "");
        vm.warp(commerce.getJob(id).expiredAt);
        XYXEvaluator.JobVerdict memory verdict = _verdict(id, 2, 9);
        bytes memory signature = _sign(verdict);
        vm.expectRevert(AgenticCommerce.WrongStatus.selector);
        evaluator.resolveJob(verdict, signature);
        assertFalse(evaluator.consumed(evaluator.hashVerdict(verdict)));
        commerce.claimRefund(id);
        assertEq(uint256(commerce.getJob(id).status), uint256(AgenticCommerce.JobStatus.Expired));
        assertEq(token.balanceOf(BUYER), 1_000_000);
    }

    function testNonceCannotBeReusedForAnotherJob() public {
        uint256 firstId = _fundedJob();
        uint256 secondId = _fundedJob();
        vm.prank(PROVIDER);
        commerce.submit(firstId, keccak256("first transfer"), "");
        vm.prank(PROVIDER);
        commerce.submit(secondId, keccak256("second transfer"), "");
        XYXEvaluator.JobVerdict memory first = _verdict(firstId, 1, 10);
        evaluator.resolveJob(first, _sign(first));
        XYXEvaluator.JobVerdict memory second = _verdict(secondId, 1, 10);
        bytes memory secondSignature = _sign(second);
        vm.expectRevert(XYXEvaluator.NonceAlreadyUsed.selector);
        evaluator.resolveJob(second, secondSignature);
        assertEq(uint256(commerce.getJob(secondId).status), uint256(AgenticCommerce.JobStatus.Submitted));
    }

    function testInvalidVerdictsDoNotConsumeNonceOrEscrow() public {
        uint256 id = _fundedJob();
        vm.prank(PROVIDER);
        commerce.submit(id, keccak256("transfer"), "");
        XYXEvaluator.JobVerdict memory future = _verdict(id, 1, 11);
        future.issuedAt = uint64(block.timestamp + 1);
        bytes memory futureSignature = _sign(future);
        vm.expectRevert(XYXEvaluator.InvalidTimestamp.selector);
        evaluator.resolveJob(future, futureSignature);
        assertFalse(evaluator.usedNonces(vm.addr(SIGNER_KEY), future.nonce));

        XYXEvaluator.JobVerdict memory invalidDecision = _verdict(id, 3, 12);
        bytes memory invalidDecisionSignature = _sign(invalidDecision);
        vm.expectRevert(XYXEvaluator.InvalidVerdict.selector);
        evaluator.resolveJob(invalidDecision, invalidDecisionSignature);
        assertFalse(evaluator.usedNonces(vm.addr(SIGNER_KEY), invalidDecision.nonce));

        XYXEvaluator.JobVerdict memory emptyEvidence = _verdict(id, 1, 13);
        emptyEvidence.evidenceHash = bytes32(0);
        bytes memory emptyEvidenceSignature = _sign(emptyEvidence);
        vm.expectRevert(XYXEvaluator.InvalidVerdict.selector);
        evaluator.resolveJob(emptyEvidence, emptyEvidenceSignature);
        assertEq(token.balanceOf(address(commerce)), 20_000);
    }

    function testRecordsFundingAndSubmissionBlocks() public {
        vm.roll(100);
        uint256 id = _fundedJob();
        assertEq(commerce.fundedAtBlock(id), 100);
        assertEq(commerce.submittedAtBlock(id), 0);

        vm.roll(102);
        bytes32 deliverable = keccak256("transfer after funding");
        vm.prank(PROVIDER);
        commerce.submit(id, deliverable, "");
        assertEq(commerce.fundedAtBlock(id), 100);
        assertEq(commerce.submittedAtBlock(id), 102);
        assertEq(commerce.deliverableJob(PROVIDER, deliverable), id);
    }

    function testProviderCannotReuseDeliverableAcrossJobs() public {
        uint256 firstId = _fundedJob();
        uint256 secondId = _fundedJob();
        bytes32 deliverable = keccak256("one transfer cannot fulfill two jobs");
        vm.prank(PROVIDER);
        commerce.submit(firstId, deliverable, "");

        vm.prank(PROVIDER);
        vm.expectRevert(AgenticCommerce.DeliverableAlreadyUsed.selector);
        commerce.submit(secondId, deliverable, "");
        assertEq(uint256(commerce.getJob(secondId).status), uint256(AgenticCommerce.JobStatus.Funded));
        assertEq(commerce.deliverables(secondId), bytes32(0));
        assertEq(commerce.submittedAtBlock(secondId), 0);
        assertEq(commerce.deliverableJob(PROVIDER, deliverable), firstId);
    }

    function testRejectedJobKeepsDeliverableReserved() public {
        uint256 firstId = _fundedJob();
        uint256 secondId = _fundedJob();
        bytes32 deliverable = keccak256("rejected transfer");
        vm.prank(PROVIDER);
        commerce.submit(firstId, deliverable, "");
        XYXEvaluator.JobVerdict memory verdict = _verdict(firstId, 2, 7);
        evaluator.resolveJob(verdict, _sign(verdict));

        vm.prank(PROVIDER);
        vm.expectRevert(AgenticCommerce.DeliverableAlreadyUsed.selector);
        commerce.submit(secondId, deliverable, "");
        assertEq(commerce.deliverableJob(PROVIDER, deliverable), firstId);
    }

    function testAnotherProviderCannotReserveVictimDeliverable() public {
        address otherProvider = address(0xCAFE);
        uint256 attackerJob = _fundedJobFor(otherProvider);
        uint256 victimJob = _fundedJob();
        bytes32 victimTransfer = keccak256("victim provider transfer");

        vm.prank(otherProvider);
        commerce.submit(attackerJob, victimTransfer, "");
        vm.prank(PROVIDER);
        commerce.submit(victimJob, victimTransfer, "");
        assertEq(commerce.deliverableJob(otherProvider, victimTransfer), attackerJob);
        assertEq(commerce.deliverableJob(PROVIDER, victimTransfer), victimJob);
        assertEq(uint256(commerce.getJob(victimJob).status), uint256(AgenticCommerce.JobStatus.Submitted));
    }

    function testPauseBlocksVerdictsButExpiryRefundRemainsAvailable() public {
        uint256 submittedId = _fundedJob();
        uint256 fundedId = _fundedJob();
        vm.prank(PROVIDER);
        commerce.submit(submittedId, keccak256("transfer before pause"), "");
        XYXEvaluator.JobVerdict memory verdict = _verdict(submittedId, 1, 8);
        bytes memory signature = _sign(verdict);
        evaluator.pause();

        vm.expectRevert(Pausable.EnforcedPause.selector);
        evaluator.resolveJob(verdict, signature);
        assertFalse(evaluator.consumed(evaluator.hashVerdict(verdict)));
        assertFalse(evaluator.usedNonces(vm.addr(SIGNER_KEY), verdict.nonce));

        vm.warp(commerce.getJob(submittedId).expiredAt);
        vm.prank(address(0xCAFE));
        commerce.claimRefund(submittedId);
        vm.prank(address(0xCAFE));
        commerce.claimRefund(fundedId);
        assertTrue(evaluator.paused());
        assertEq(uint256(commerce.getJob(submittedId).status), uint256(AgenticCommerce.JobStatus.Expired));
        assertEq(uint256(commerce.getJob(fundedId).status), uint256(AgenticCommerce.JobStatus.Expired));
        assertEq(token.balanceOf(BUYER), 1_000_000);
        assertEq(token.balanceOf(address(commerce)), 0);
        vm.expectRevert(AgenticCommerce.WrongStatus.selector);
        commerce.claimRefund(submittedId);
    }
}
