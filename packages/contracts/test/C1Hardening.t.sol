// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {AgenticCommerce} from "../src/AgenticCommerce.sol";
import {XYXEvaluator} from "../src/XYXEvaluator.sol";

contract TestUSDCv2 is ERC20 {
    constructor() ERC20("Test USDC", "USDC") {}
    function decimals() public pure override returns (uint8) { return 6; }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

contract FailingToken is ERC20 {
    constructor() ERC20("Fail Token", "FLT") {}
    function decimals() public pure override returns (uint8) { return 6; }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
    function transfer(address, uint256) public pure override returns (bool) {
        return false;
    }
    function transferFrom(address, address, uint256) public pure override returns (bool) {
        return false;
    }
}

contract ConditionalFailingToken is ERC20 {
    bool private failSettlement;
    constructor(address) ERC20("Cond Fail", "CFT") {}
    function decimals() public pure override returns (uint8) { return 6; }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
    function setFailSettlement(bool _fail) external { failSettlement = _fail; }
    function transfer(address recipient, uint256 amount) public override returns (bool) {
        if (failSettlement) {
            return false;
        }
        _transfer(msg.sender, recipient, amount);
        return true;
    }
    function transferFrom(address sender, address recipient, uint256 amount) public override returns (bool) {
        _spendAllowance(sender, msg.sender, amount);
        _transfer(sender, recipient, amount);
        return true;
    }
}

// --- Reentrancy helpers ---

contract ReentrantFundToken is ERC20 {
    AgenticCommerce public commerce;
    bool public reentered;
    bool private rethrow;
    uint256 public targetJobId;
    uint256 public targetBudget;
    uint256 public nextJobId;

    constructor(address _commerce) ERC20("ReentrantF", "RTF") {
        commerce = AgenticCommerce(_commerce);
    }
    function setCommerce(address _commerce) external { commerce = AgenticCommerce(_commerce); }
    function decimals() public pure override returns (uint8) { return 6; }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
    function setTarget(uint256 _jobId, uint256 _budget) external { targetJobId = _jobId; targetBudget = _budget; }
    function setRethrow(bool _rethrow) external { rethrow = _rethrow; }
    function transfer(address recipient, uint256 amount) public override returns (bool) {
        _transfer(msg.sender, recipient, amount);
        return true;
    }
    function transferFrom(address sender, address recipient, uint256 amount) public override returns (bool) {
        _spendAllowance(sender, msg.sender, amount);
        _transfer(sender, recipient, amount);
        // msg.sender is commerce. Reenter fund on target job where THIS TOKEN is the client.
        (bool success, bytes memory ret) = msg.sender.call(
            abi.encodeWithSelector(AgenticCommerce.fund.selector, targetJobId, targetBudget, "")
        );
        reentered = success;
        if (!success && rethrow) {
            assembly {
                returndatacopy(0, 0, returndatasize())
                revert(0, returndatasize())
            }
        }
        return true;
    }
    // Helper: token itself creates jobs as client, sets budgets, approves commerce, and funds outer job.
    function createFundSetup(address provider, address evaluator, uint256 budgetA, uint256 budgetB) external returns (uint256 idA, uint256 idB) {
        require(evaluator != address(0), "zero evaluator");
        idA = commerce.createJob(provider, evaluator, block.timestamp + 1 days, "ipfs://specA", address(0));
        idB = commerce.createJob(provider, evaluator, block.timestamp + 1 days, "ipfs://specB", address(0));
        commerce.setBudget(idA, budgetA, "");
        commerce.setBudget(idB, budgetB, "");
        ERC20(address(this)).approve(address(commerce), budgetA + budgetB);
        nextJobId = idB + 1;
    }
    function fundOuter(uint256 jobId, uint256 budget) external {
        commerce.fund(jobId, budget, "");
    }
    function executeComplete(uint256 jobId) external {
        commerce.complete(jobId, bytes32(0), "");
    }
}

contract ReentrantCompleteToken is ERC20 {
    AgenticCommerce public commerce;
    bool public reentered;
    bool private rethrow;
    uint256 public targetJobId;
    uint256 public nextJobId;

    constructor(address _commerce) ERC20("ReentrantC", "RNTC") {
        commerce = AgenticCommerce(_commerce);
    }
    function setCommerce(address _commerce) external { commerce = AgenticCommerce(_commerce); }
    function decimals() public pure override returns (uint8) { return 6; }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
    function setTarget(uint256 _jobId) external { targetJobId = _jobId; }
    function setRethrow(bool _rethrow) external { rethrow = _rethrow; }
    function transfer(address recipient, uint256 amount) public override returns (bool) {
        _transfer(msg.sender, recipient, amount);
        // msg.sender is commerce. Reenter complete on target job where THIS TOKEN is the evaluator.
        (bool success, bytes memory ret) = msg.sender.call(
            abi.encodeWithSelector(AgenticCommerce.complete.selector, targetJobId, bytes32(0), "")
        );
        reentered = success;
        if (!success && rethrow) {
            assembly {
                returndatacopy(0, 0, returndatasize())
                revert(0, returndatasize())
            }
        }
        return true;
    }
    function transferFrom(address sender, address recipient, uint256 amount) public override returns (bool) {
        _spendAllowance(sender, msg.sender, amount);
        _transfer(sender, recipient, amount);
        return true;
    }
    // Helper: token itself sets up jobs as evaluator, funds and submits them.
    function createCompleteSetup(address buyer, address provider, uint256 budgetA, uint256 budgetB) external returns (uint256 idA, uint256 idB) {
        require(buyer != address(0), "zero buyer");
        require(provider != address(0), "zero provider");
        // The token must be both provider and evaluator so its transfer callback
        // can make an authorized nested complete call against the second job.
        idA = commerce.createJob(address(this), address(this), block.timestamp + 1 days, "ipfs://specA", address(0));
        idB = commerce.createJob(address(this), address(this), block.timestamp + 1 days, "ipfs://specB", address(0));
        commerce.setBudget(idA, budgetA, "");
        commerce.setBudget(idB, budgetB, "");
        ERC20(address(this)).approve(address(commerce), budgetA + budgetB);
        nextJobId = idB + 1;
    }
    function fundAndSubmit(uint256 jobId, uint256 budget, bytes32 deliverable) external {
        commerce.fund(jobId, budget, "");
        commerce.submit(jobId, deliverable, "");
    }
    function fundJob(uint256 jobId) external {
        commerce.fund(jobId, 0, "");
    }
    function submitJob(uint256 jobId, bytes32 deliverable) external {
        commerce.submit(jobId, deliverable, "");
    }
    function executeComplete(uint256 jobId) external {
        commerce.complete(jobId, bytes32(0), "");
    }
}

contract C1HardeningTest is Test {
    uint256 internal constant SIGNER_KEY = 0xDEADBEEF;
    address internal constant BUYER = address(0xB0B);
    address internal constant PROVIDER = address(0xBEEF);
    uint256 internal constant NO_ROLE_SIGNER_KEY = 0xCAFE;
    address internal constant FAKE_ATTESTOR = address(0xFACE);

    TestUSDCv2 internal token;
    AgenticCommerce internal commerce;
    XYXEvaluator internal evaluator;
    XYXEvaluator internal fakeEvaluator;

    function setUp() public {
        vm.chainId(10143);
        token = new TestUSDCv2();
        commerce = new AgenticCommerce(address(token));
        evaluator = new XYXEvaluator(address(this), vm.addr(SIGNER_KEY), address(this), address(commerce), 300);
        fakeEvaluator = new XYXEvaluator(address(this), FAKE_ATTESTOR, address(this), address(commerce), 300);
        token.mint(BUYER, 1_000_000);
        vm.prank(BUYER);
        token.approve(address(commerce), type(uint256).max);
    }

    function _fundedJob() internal returns (uint256 id) {
        vm.prank(BUYER);
        id = commerce.createJob(PROVIDER, address(evaluator), block.timestamp + 1 days, "ipfs://spec", address(0));
        vm.prank(PROVIDER);
        commerce.setBudget(id, 20_000, "");
        vm.prank(BUYER);
        commerce.fund(id, 20_000, "");
    }

    function _verdict(uint256 id, uint8 decision, uint64 nonce) internal view returns (XYXEvaluator.JobVerdict memory) {
        return XYXEvaluator.JobVerdict(id, keccak256("evidence"), keccak256("reason"), decision,
            uint64(block.timestamp), uint64(block.timestamp + 120), nonce);
    }

    function _sign(uint256 signerKey, XYXEvaluator.JobVerdict memory verdict) internal view returns (bytes memory) {
        bytes32 digest = evaluator.hashVerdict(verdict);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, digest);
        return abi.encodePacked(r, s, v);
    }

    function _signEvaluator(uint256 signerKey, XYXEvaluator evaluator_, XYXEvaluator.JobVerdict memory verdict) internal view returns (bytes memory) {
        bytes32 digest = evaluator_.hashVerdict(verdict);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, digest);
        return abi.encodePacked(r, s, v);
    }

    // --- Wrong EIP-712 verifying contract ---
    function testWrongVerifyingContractDomainRevertsAndDoesNotConsumeGuards() public {
        uint256 id = _fundedJob();
        vm.prank(PROVIDER);
        commerce.submit(id, keccak256("transfer tx"), "");

        XYXEvaluator.JobVerdict memory verdict = _verdict(id, 1, 1);
        // Sign with fake evaluator's domain separator
        bytes memory fakeSig = _signEvaluator(SIGNER_KEY, fakeEvaluator, verdict);
        vm.expectRevert();
        evaluator.resolveJob(verdict, fakeSig);
        assertEq(token.balanceOf(address(commerce)), 20_000);
        assertFalse(evaluator.consumed(evaluator.hashVerdict(verdict)));
        assertFalse(evaluator.usedNonces(vm.addr(SIGNER_KEY), verdict.nonce));
    }

    // --- Signer without ATTESTOR_ROLE ---
    function testSignerWithoutAttestorRoleRevertsAndDoesNotConsumeGuards() public {
        uint256 id = _fundedJob();
        vm.prank(PROVIDER);
        commerce.submit(id, keccak256("transfer tx"), "");

        XYXEvaluator.JobVerdict memory verdict = _verdict(id, 1, 2);
        bytes memory noRoleSig = _sign(NO_ROLE_SIGNER_KEY, verdict);
        vm.expectRevert();
        evaluator.resolveJob(verdict, noRoleSig);
        assertEq(token.balanceOf(address(commerce)), 20_000);
        assertFalse(evaluator.consumed(evaluator.hashVerdict(verdict)));
        assertFalse(evaluator.usedNonces(vm.addr(SIGNER_KEY), verdict.nonce));
    }

    // --- Revoked role ---
    function testRevokedAttestorRoleCannotResolveAndDoesNotConsumeGuards() public {
        uint256 id = _fundedJob();
        vm.prank(PROVIDER);
        commerce.submit(id, keccak256("transfer tx"), "");

        vm.prank(address(this)); // admin
        evaluator.revokeRole(bytes32(keccak256("ATTESTOR_ROLE")), vm.addr(SIGNER_KEY));

        XYXEvaluator.JobVerdict memory verdict = _verdict(id, 1, 3);
        bytes memory revokedSig = _sign(SIGNER_KEY, verdict);
        vm.expectRevert();
        evaluator.resolveJob(verdict, revokedSig);
        assertEq(token.balanceOf(address(commerce)), 20_000);
        assertFalse(evaluator.consumed(evaluator.hashVerdict(verdict)));
        assertFalse(evaluator.usedNonces(vm.addr(SIGNER_KEY), verdict.nonce));
    }

    // --- Pause/unpause restores verdicts ---
    function testPauseThenUnpauseRestoresVerdictExecution() public {
        uint256 id = _fundedJob();
        vm.prank(PROVIDER);
        commerce.submit(id, keccak256("transfer tx"), "");

        XYXEvaluator.JobVerdict memory verdict = _verdict(id, 1, 4);
        bytes memory signature = _sign(SIGNER_KEY, verdict);

        evaluator.pause();
        vm.expectRevert(Pausable.EnforcedPause.selector);
        evaluator.resolveJob(verdict, signature);
        assertFalse(evaluator.consumed(evaluator.hashVerdict(verdict)));
        assertFalse(evaluator.usedNonces(vm.addr(SIGNER_KEY), verdict.nonce));

        evaluator.unpause();
        XYXEvaluator.JobVerdict memory verdict2 = _verdict(id, 1, 5);
        bytes memory signature2 = _sign(SIGNER_KEY, verdict2);
        evaluator.resolveJob(verdict2, signature2);
        assertEq(uint256(commerce.getJob(id).status), uint256(AgenticCommerce.JobStatus.Completed));
        assertEq(token.balanceOf(PROVIDER), 20_000);
    }

    // --- Verdict lifetime boundary: exact max is valid ---
    function testVerdictLifetimeExactMaxBoundaryIsValid() public {
        uint256 id = _fundedJob();
        vm.prank(PROVIDER);
        commerce.submit(id, keccak256("transfer tx"), "");

        // maxVerdictLifetime = 300
        XYXEvaluator.JobVerdict memory verdict = _verdict(id, 1, 6);
        verdict.expiresAt = uint64(block.timestamp + 300);
        bytes memory signature = _sign(SIGNER_KEY, verdict);
        evaluator.resolveJob(verdict, signature);
        assertEq(uint256(commerce.getJob(id).status), uint256(AgenticCommerce.JobStatus.Completed));
    }

    // --- Verdict lifetime boundary: exceeds max reverts ---
    function testVerdictLifetimeExceedingMaxRevertsAndDoesNotConsumeGuards() public {
        uint256 id = _fundedJob();
        vm.prank(PROVIDER);
        commerce.submit(id, keccak256("transfer tx"), "");

        XYXEvaluator.JobVerdict memory verdict = _verdict(id, 1, 7);
        verdict.expiresAt = uint64(block.timestamp + 301); // exceeds 300
        bytes memory signature = _sign(SIGNER_KEY, verdict);
        vm.expectRevert(XYXEvaluator.InvalidTimestamp.selector);
        evaluator.resolveJob(verdict, signature);
        assertFalse(evaluator.consumed(evaluator.hashVerdict(verdict)));
        assertFalse(evaluator.usedNonces(vm.addr(SIGNER_KEY), verdict.nonce));
    }

    // --- Verdict lifetime boundary: zero lifetime ---
    function testVerdictLifetimeZeroRevertsAndDoesNotConsumeGuards() public {
        uint256 id = _fundedJob();
        vm.prank(PROVIDER);
        commerce.submit(id, keccak256("transfer tx"), "");

        XYXEvaluator.JobVerdict memory verdict = _verdict(id, 1, 8);
        verdict.issuedAt = uint64(block.timestamp);
        verdict.expiresAt = uint64(block.timestamp); // zero lifetime
        bytes memory signature = _sign(SIGNER_KEY, verdict);
        vm.expectRevert(XYXEvaluator.InvalidTimestamp.selector);
        evaluator.resolveJob(verdict, signature);
        assertFalse(evaluator.consumed(evaluator.hashVerdict(verdict)));
        assertFalse(evaluator.usedNonces(vm.addr(SIGNER_KEY), verdict.nonce));
    }

    // --- Nonce/digest replay: exact same verdict replayed ---
    function testDigestReplayIsRejected() public {
        uint256 id = _fundedJob();
        vm.prank(PROVIDER);
        commerce.submit(id, keccak256("transfer tx"), "");

        XYXEvaluator.JobVerdict memory verdict = _verdict(id, 1, 9);
        bytes memory signature = _sign(SIGNER_KEY, verdict);
        evaluator.resolveJob(verdict, signature);
        assertEq(uint256(commerce.getJob(id).status), uint256(AgenticCommerce.JobStatus.Completed));

        // Replay exact same verdict digest with same signature
        vm.expectRevert(XYXEvaluator.VerdictAlreadyConsumed.selector);
        evaluator.resolveJob(verdict, signature);
    }

    // --- Token revert: fund failure does not corrupt job state ---
    function testTokenRevertOnFundDoesNotCorruptState() public {
        FailingToken failingToken = new FailingToken();
        failingToken.mint(BUYER, 1_000_000);
        AgenticCommerce failingCommerce = new AgenticCommerce(address(failingToken));
        XYXEvaluator failingEvaluator = new XYXEvaluator(address(this), vm.addr(SIGNER_KEY), address(this), address(failingCommerce), 300);
        vm.prank(BUYER);
        failingToken.approve(address(failingCommerce), type(uint256).max);

        uint256 id;
        vm.prank(BUYER);
        id = failingCommerce.createJob(PROVIDER, address(failingEvaluator), block.timestamp + 1 days, "ipfs://spec", address(0));
        vm.prank(PROVIDER);
        failingCommerce.setBudget(id, 20_000, "");
        vm.expectRevert();
        vm.prank(BUYER);
        failingCommerce.fund(id, 20_000, "");

        // Job must remain Open after failed fund; no tokens moved
        assertEq(uint256(failingCommerce.getJob(id).status), uint256(AgenticCommerce.JobStatus.Open));
        assertEq(failingToken.balanceOf(address(failingCommerce)), 0);
    }

    // --- Token false-return on settlement does not corrupt state or consume evaluator guards ---
    function testTokenFalseReturnOnSettlementDoesNotCorruptStateOrConsumeGuards() public {
        ConditionalFailingToken condToken = new ConditionalFailingToken(address(0));
        condToken.mint(BUYER, 1_000_000);

        // Create a separate commerce+evaluator pair for this test
        AgenticCommerce condCommerce = new AgenticCommerce(address(condToken));
        XYXEvaluator condEvaluator = new XYXEvaluator(address(this), vm.addr(SIGNER_KEY), address(this), address(condCommerce), 300);

        vm.prank(BUYER);
        condToken.approve(address(condCommerce), type(uint256).max);

        vm.prank(BUYER);
        uint256 id = condCommerce.createJob(PROVIDER, address(condEvaluator), block.timestamp + 1 days, "ipfs://spec", address(0));
        vm.prank(PROVIDER);
        condCommerce.setBudget(id, 20_000, "");
        vm.prank(BUYER);
        condCommerce.fund(id, 20_000, "");
        vm.prank(PROVIDER);
        condCommerce.submit(id, keccak256("transfer tx"), "");

        // Enable settlement failure
        condToken.setFailSettlement(true);

        XYXEvaluator.JobVerdict memory verdict = XYXEvaluator.JobVerdict(id, keccak256("evidence"), keccak256("reason"), 1,
            uint64(block.timestamp), uint64(block.timestamp + 120), 10);
        bytes memory signature = _signEvaluator(SIGNER_KEY, condEvaluator, verdict);
        vm.expectRevert();
        condEvaluator.resolveJob(verdict, signature);

        // Commerce job must remain Submitted; evaluator guards must NOT be consumed
        assertEq(uint256(condCommerce.getJob(id).status), uint256(AgenticCommerce.JobStatus.Submitted));
        assertFalse(condEvaluator.consumed(condEvaluator.hashVerdict(verdict)));
        assertFalse(condEvaluator.usedNonces(vm.addr(SIGNER_KEY), verdict.nonce));
    }

    // --- Reentrancy guard blocks token callback into a second fund ---
    function testReentrancyGuardBlocksReentrantFund() public {
        // Token is the buyer for both jobs and initiates the outer fund call itself.
        ReentrantFundToken reToken = new ReentrantFundToken(address(0)); // commerce set below
        reToken.mint(address(reToken), 1_000_000);

        AgenticCommerce reCommerce = new AgenticCommerce(address(reToken));
        reToken.setCommerce(address(reCommerce));
        XYXEvaluator reEvaluator = new XYXEvaluator(address(this), vm.addr(SIGNER_KEY), address(this), address(reCommerce), 300);

        vm.prank(address(reToken));
        reToken.approve(address(reCommerce), type(uint256).max);

        // Token creates both jobs as client, sets budgets, and approves commerce.
        vm.prank(address(reToken));
        (uint256 idA, uint256 idB) = reToken.createFundSetup(PROVIDER, address(reEvaluator), 20_000, 20_000);

        reToken.setTarget(idB, 20_000);

        // Outer fund on idA succeeds; inner reentrant fund on idB is blocked by guard.
        // Token catches revert, so safeTransferFrom succeeds and outer fund completes.
        vm.prank(address(reToken));
        reToken.fundOuter(idA, 20_000);

        assertEq(uint256(reCommerce.getJob(idA).status), uint256(AgenticCommerce.JobStatus.Funded));
        assertEq(uint256(reCommerce.getJob(idB).status), uint256(AgenticCommerce.JobStatus.Open));
        assertEq(reToken.balanceOf(address(reCommerce)), 20_000);
        assertFalse(reToken.reentered());

        // Prove inner call is valid: direct fund on idB succeeds without reentrant context
        vm.prank(address(reToken));
        reToken.fundOuter(idB, 20_000);
        assertEq(uint256(reCommerce.getJob(idB).status), uint256(AgenticCommerce.JobStatus.Funded));
        assertEq(reToken.balanceOf(address(reCommerce)), 40_000);
    }

    // --- Reentrancy guard blocks token callback into a second complete ---
    function testReentrancyGuardBlocksReentrantComplete() public {
        // Token is the evaluator for both jobs and initiates the outer complete call itself.
        ReentrantCompleteToken reToken = new ReentrantCompleteToken(address(0));
        reToken.mint(address(reToken), 1_000_000);

        AgenticCommerce reCommerce = new AgenticCommerce(address(reToken));
        reToken.setCommerce(address(reCommerce));
        XYXEvaluator reEvaluator = new XYXEvaluator(address(this), vm.addr(SIGNER_KEY), address(this), address(reCommerce), 300);

        // Token creates both jobs as evaluator, funds and submits them.
        vm.prank(address(reToken));
        (uint256 idA, uint256 idB) = reToken.createCompleteSetup(BUYER, PROVIDER, 20_000, 20_000);

        // The token owns the buyer/evaluator roles for this adversarial fixture.
        // Both jobs are valid and submitted before the reentrant settlement attempt.
        reToken.fundAndSubmit(idA, 20_000, keccak256("txA"));
        reToken.fundAndSubmit(idB, 20_000, keccak256("txB"));

        reToken.setTarget(idB);

        // Token (as evaluator) initiates outer complete on idA via its own method.
        // Inside complete, commerce calls paymentToken.safeTransfer(provider, budget) on reToken.
        // reToken.transfer reenters by calling complete on idB. Guard blocks nested complete.
        vm.prank(address(reToken));
        reToken.executeComplete(idA);

        assertEq(uint256(reCommerce.getJob(idA).status), uint256(AgenticCommerce.JobStatus.Completed));
        assertEq(uint256(reCommerce.getJob(idB).status), uint256(AgenticCommerce.JobStatus.Submitted));
        assertEq(reToken.balanceOf(address(reToken)), 980_000); // one transfer back to the token provider
        assertFalse(reToken.reentered());

        // Prove inner call is valid: direct complete on idB succeeds without guard
        vm.prank(address(reToken));
        reToken.executeComplete(idB);
        assertEq(uint256(reCommerce.getJob(idB).status), uint256(AgenticCommerce.JobStatus.Completed));
        assertEq(reToken.balanceOf(address(reToken)), 1_000_000);
    }

    // --- Prove nested revert selector is exactly ReentrancyGuardReentrantCall ---
    function testReentrancyNestedRevertSelectorIsExact() public {
        // Use rethrow mode to bubble the exact revert data out of the token callback.
        ReentrantFundToken reToken = new ReentrantFundToken(address(0));
        reToken.setRethrow(true);
        reToken.mint(address(reToken), 1_000_000);

        AgenticCommerce reCommerce = new AgenticCommerce(address(reToken));
        reToken.setCommerce(address(reCommerce));
        XYXEvaluator reEvaluator = new XYXEvaluator(address(this), vm.addr(SIGNER_KEY), address(this), address(reCommerce), 300);

        vm.prank(address(reToken));
        reToken.approve(address(reCommerce), type(uint256).max);

        vm.prank(address(reToken));
        (uint256 idA, uint256 idB) = reToken.createFundSetup(PROVIDER, address(reEvaluator), 20_000, 20_000);

        reToken.setTarget(idB, 20_000);

        // The nested call is authorized and valid without the guard (same client, budget matches, Open/Unexpired).
        // Prove the guard is the actual reverting condition by bubbling its exact selector.
        vm.prank(address(reToken));
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        reToken.fundOuter(idA, 20_000);
    }

    // --- Failed settlement preserves escrow invariant ---
    function testEscrowBalanceEqualsSumOfActiveJobsAfterFailedSettlement() public {
        // Fund two jobs successfully
        uint256 id1 = _fundedJob();
        uint256 id2 = _fundedJob();
        assertEq(token.balanceOf(address(commerce)), 40_000);

        // Submit first job and attempt settlement with failing token
        ConditionalFailingToken condToken = new ConditionalFailingToken(address(0));
        condToken.mint(BUYER, 1_000_000);

        AgenticCommerce condCommerce = new AgenticCommerce(address(condToken));
        XYXEvaluator condEvaluator = new XYXEvaluator(address(this), vm.addr(SIGNER_KEY), address(this), address(condCommerce), 300);

        vm.prank(BUYER);
        condToken.approve(address(condCommerce), type(uint256).max);

        vm.prank(BUYER);
        uint256 id3 = condCommerce.createJob(PROVIDER, address(condEvaluator), block.timestamp + 1 days, "ipfs://spec", address(0));
        vm.prank(PROVIDER);
        condCommerce.setBudget(id3, 15_000, "");
        vm.prank(BUYER);
        condCommerce.fund(id3, 15_000, "");
        vm.prank(PROVIDER);
        condCommerce.submit(id3, keccak256("transfer tx"), "");
        condToken.setFailSettlement(true);

        XYXEvaluator.JobVerdict memory verdict = XYXEvaluator.JobVerdict(id3, keccak256("evidence"), keccak256("reason"), 1,
            uint64(block.timestamp), uint64(block.timestamp + 120), 13);
        bytes memory signature = _signEvaluator(SIGNER_KEY, condEvaluator, verdict);
        vm.expectRevert();
        condEvaluator.resolveJob(verdict, signature);

        // Active escrow balance must equal funded jobs (id1, id2, id3)
        assertEq(uint256(condCommerce.getJob(id3).status), uint256(AgenticCommerce.JobStatus.Submitted));
        assertEq(condToken.balanceOf(address(condCommerce)), 15_000);
        // Original commerce still has its two funded jobs
        assertEq(uint256(commerce.getJob(id1).status), uint256(AgenticCommerce.JobStatus.Funded));
        assertEq(uint256(commerce.getJob(id2).status), uint256(AgenticCommerce.JobStatus.Funded));
    }
}
