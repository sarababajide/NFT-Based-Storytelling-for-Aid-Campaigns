// FundEscrowMock.test.ts
import { describe, expect, it, beforeEach } from "vitest";

// Interfaces for type safety
interface ClarityResponse<T> {
  ok: boolean;
  value: T | number; // number for error codes
}

interface Milestone {
  description: string;
  targetAmount: number;
  verified: boolean;
  releasePercentage: number;
  verifier?: string;
  verificationTimestamp?: number;
}

interface ProjectEscrow {
  totalFunded: number;
  released: number;
  milestonesCount: number;
  active: boolean;
  refundWindowStart?: number;
  recipient: string;
}

interface Contribution {
  amount: number;
  timestamp: number;
  refunded: boolean;
}

interface ContractState {
  contractOwner: string;
  paused: boolean;
  totalEscrowed: number;
  initialized: boolean;
  projectEscrows: Map<string, ProjectEscrow>;
  milestones: Map<string, Map<number, Milestone>>;
  fundContributions: Map<string, Map<string, Contribution>>;
  blockHeight: number; // Mocked block height
  contractBalance: number; // Mocked STX balance
}

// Mock contract implementation
class FundEscrowMock {
  private state: ContractState = {
    contractOwner: "deployer",
    paused: false,
    totalEscrowed: 0,
    initialized: false,
    projectEscrows: new Map(),
    milestones: new Map(),
    fundContributions: new Map(),
    blockHeight: 1000,
    contractBalance: 0,
  };

  private ERR_NOT_AUTHORIZED = 100;
  private ERR_PROJECT_NOT_EXIST = 101;
  private ERR_MILESTONE_NOT_VERIFIED = 102;
  private ERR_INSUFFICIENT_FUNDS = 103;
  private ERR_ALREADY_RELEASED = 104;
  private ERR_PAUSED = 105;
  private ERR_INVALID_AMOUNT = 106;
  private ERR_INVALID_RECIPIENT = 107;
  private ERR_MAX_MILESTONES_REACHED = 108;
  private ERR_INVALID_MILESTONE_INDEX = 109;
  private ERR_REFUND_NOT_ALLOWED = 110;
  private ERR_CONTRACT_NOT_INITIALIZED = 111;
  private ERR_ALREADY_INITIALIZED = 112;
  private ERR_INVALID_PERCENTAGE = 113;
  private MAX_MILESTONES = 10;
  private REFUND_GRACE_PERIOD = 144;

  // Helper to simulate block height increase
  advanceBlock() {
    this.state.blockHeight += 1;
  }

  // Simulate STX transfer in
  simulateStxTransferIn(amount: number) {
    this.state.contractBalance += amount;
  }

  // Simulate STX transfer out
  private simulateStxTransferOut(amount: number): boolean {
    if (this.state.contractBalance < amount) {
      return false;
    }
    this.state.contractBalance -= amount;
    return true;
  }

  initialize(caller: string): ClarityResponse<boolean> {
    if (caller !== this.state.contractOwner) {
      return { ok: false, value: this.ERR_NOT_AUTHORIZED };
    }
    if (this.state.initialized) {
      return { ok: false, value: this.ERR_ALREADY_INITIALIZED };
    }
    this.state.initialized = true;
    return { ok: true, value: true };
  }

  pause(caller: string): ClarityResponse<boolean> {
    if (caller !== this.state.contractOwner) {
      return { ok: false, value: this.ERR_NOT_AUTHORIZED };
    }
    this.state.paused = true;
    return { ok: true, value: true };
  }

  unpause(caller: string): ClarityResponse<boolean> {
    if (caller !== this.state.contractOwner) {
      return { ok: false, value: this.ERR_NOT_AUTHORIZED };
    }
    this.state.paused = false;
    return { ok: true, value: true };
  }

  createProjectEscrow(
    caller: string,
    projectId: string,
    recipient: string,
    initialMilestones: Array<{description: string, targetAmount: number, releasePercentage: number}>
  ): ClarityResponse<boolean> {
    if (this.state.paused) {
      return { ok: false, value: this.ERR_PAUSED };
    }
    if (caller !== this.state.contractOwner) {
      return { ok: false, value: this.ERR_NOT_AUTHORIZED };
    }
    if (this.state.projectEscrows.has(projectId)) {
      return { ok: false, value: this.ERR_PROJECT_NOT_EXIST };
    }
    if (initialMilestones.length > this.MAX_MILESTONES) {
      return { ok: false, value: this.ERR_MAX_MILESTONES_REACHED };
    }
    this.state.projectEscrows.set(projectId, {
      totalFunded: 0,
      released: 0,
      milestonesCount: initialMilestones.length,
      active: true,
      refundWindowStart: undefined,
      recipient,
    });
    const projectMilestones = new Map<number, Milestone>();
    initialMilestones.forEach((ms, index) => {
      if (ms.releasePercentage > 100) {
        throw new Error("Invalid percentage"); // Simulate assert failure
      }
      projectMilestones.set(index, {
        description: ms.description,
        targetAmount: ms.targetAmount,
        verified: false,
        releasePercentage: ms.releasePercentage,
      });
    });
    this.state.milestones.set(projectId, projectMilestones);
    return { ok: true, value: true };
  }

  fundEscrow(
    caller: string,
    projectId: string,
    amount: number
  ): ClarityResponse<boolean> {
    if (this.state.paused) {
      return { ok: false, value: this.ERR_PAUSED };
    }
    if (amount <= 0) {
      return { ok: false, value: this.ERR_INVALID_AMOUNT };
    }
    const project = this.state.projectEscrows.get(projectId);
    if (!project || !project.active) {
      return { ok: false, value: this.ERR_PROJECT_NOT_EXIST };
    }
    // Simulate transfer in
    this.simulateStxTransferIn(amount);
    project.totalFunded += amount;
    this.state.totalEscrowed += amount;
    let contribs = this.state.fundContributions.get(projectId) || new Map<string, Contribution>();
    let contrib = contribs.get(caller) || { amount: 0, timestamp: 0, refunded: false };
    contrib.amount += amount;
    contrib.timestamp = this.state.blockHeight;
    contribs.set(caller, contrib);
    this.state.fundContributions.set(projectId, contribs);
    return { ok: true, value: true };
  }

  verifyAndRelease(
    caller: string,
    projectId: string,
    milestoneIndex: number,
    verifier: string
  ): ClarityResponse<boolean> {
    if (this.state.paused) {
      return { ok: false, value: this.ERR_PAUSED };
    }
    if (caller !== this.state.contractOwner) {
      return { ok: false, value: this.ERR_NOT_AUTHORIZED };
    }
    const project = this.state.projectEscrows.get(projectId);
    if (!project || !project.active) {
      return { ok: false, value: this.ERR_PROJECT_NOT_EXIST };
    }
    const projectMilestones = this.state.milestones.get(projectId);
    if (!projectMilestones) {
      return { ok: false, value: this.ERR_INVALID_MILESTONE_INDEX };
    }
    const milestone = projectMilestones.get(milestoneIndex);
    if (!milestone) {
      return { ok: false, value: this.ERR_INVALID_MILESTONE_INDEX };
    }
    if (milestone.verified) {
      return { ok: false, value: this.ERR_ALREADY_RELEASED };
    }
    const releaseAmount = Math.floor((project.totalFunded * milestone.releasePercentage) / 100);
    if (this.state.contractBalance < releaseAmount) {
      return { ok: false, value: this.ERR_INSUFFICIENT_FUNDS };
    }
    milestone.verified = true;
    milestone.verifier = verifier;
    milestone.verificationTimestamp = this.state.blockHeight;
    project.released += releaseAmount;
    if (!this.simulateStxTransferOut(releaseAmount)) {
      throw new Error("Transfer failed");
    }
    return { ok: true, value: true };
  }

  initiateRefundWindow(
    caller: string,
    projectId: string
  ): ClarityResponse<boolean> {
    if (caller !== this.state.contractOwner) {
      return { ok: false, value: this.ERR_NOT_AUTHORIZED };
    }
    const project = this.state.projectEscrows.get(projectId);
    if (!project || !project.active) {
      return { ok: false, value: this.ERR_PROJECT_NOT_EXIST };
    }
    if (project.refundWindowStart !== undefined) {
      return { ok: false, value: this.ERR_REFUND_NOT_ALLOWED };
    }
    project.active = false;
    project.refundWindowStart = this.state.blockHeight;
    return { ok: true, value: true };
  }

  claimRefund(
    caller: string,
    projectId: string
  ): ClarityResponse<boolean> {
    if (this.state.paused) {
      return { ok: false, value: this.ERR_PAUSED };
    }
    const project = this.state.projectEscrows.get(projectId);
    if (!project) {
      return { ok: false, value: this.ERR_PROJECT_NOT_EXIST };
    }
    if (project.active || project.refundWindowStart === undefined) {
      return { ok: false, value: this.ERR_REFUND_NOT_ALLOWED };
    }
    if (this.state.blockHeight >= project.refundWindowStart + this.REFUND_GRACE_PERIOD) {
      return { ok: false, value: this.ERR_REFUND_NOT_ALLOWED };
    }
    const contribs = this.state.fundContributions.get(projectId);
    if (!contribs) {
      return { ok: false, value: this.ERR_NOT_AUTHORIZED };
    }
    const contrib = contribs.get(caller);
    if (!contrib || contrib.refunded) {
      return { ok: false, value: this.ERR_ALREADY_RELEASED };
    }
    const refundAmount = contrib.amount;
    if (this.state.contractBalance < refundAmount) {
      return { ok: false, value: this.ERR_INSUFFICIENT_FUNDS };
    }
    contrib.refunded = true;
    if (!this.simulateStxTransferOut(refundAmount)) {
      throw new Error("Transfer failed");
    }
    return { ok: true, value: true };
  }

  getProjectEscrow(projectId: string): ClarityResponse<ProjectEscrow | undefined> {
    return { ok: true, value: this.state.projectEscrows.get(projectId) };
  }

  getMilestone(projectId: string, milestoneIndex: number): ClarityResponse<Milestone | undefined> {
    const projectMilestones = this.state.milestones.get(projectId);
    return { ok: true, value: projectMilestones?.get(milestoneIndex) };
  }

  getContribution(projectId: string, contributor: string): ClarityResponse<Contribution | undefined> {
    const contribs = this.state.fundContributions.get(projectId);
    return { ok: true, value: contribs?.get(contributor) };
  }

  getTotalEscrowed(): ClarityResponse<number> {
    return { ok: true, value: this.state.totalEscrowed };
  }

  getContractBalance(): ClarityResponse<number> {
    return { ok: true, value: this.state.contractBalance };
  }

  isContractPaused(): ClarityResponse<boolean> {
    return { ok: true, value: this.state.paused };
  }
}

// Test setup
const accounts = {
  deployer: "deployer",
  oracle: "oracle",
  recipient: "recipient",
  contributor1: "contributor1",
  contributor2: "contributor2",
};

describe("FundEscrow Contract", () => {
  let contract: FundEscrowMock;

  beforeEach(() => {
    contract = new FundEscrowMock();
  });

  it("should initialize the contract", () => {
    const initResult = contract.initialize(accounts.deployer);
    expect(initResult).toEqual({ ok: true, value: true });
    const secondInit = contract.initialize(accounts.deployer);
    expect(secondInit).toEqual({ ok: false, value: 112 });
  });

  it("should allow owner to pause and unpause", () => {
    const pauseResult = contract.pause(accounts.deployer);
    expect(pauseResult).toEqual({ ok: true, value: true });
    expect(contract.isContractPaused()).toEqual({ ok: true, value: true });

    const unpauseResult = contract.unpause(accounts.deployer);
    expect(unpauseResult).toEqual({ ok: true, value: true });
    expect(contract.isContractPaused()).toEqual({ ok: true, value: false });
  });

  it("should create project escrow with milestones", () => {
    const milestones = [
      { description: "Milestone 1", targetAmount: 1000, releasePercentage: 50 },
      { description: "Milestone 2", targetAmount: 2000, releasePercentage: 50 },
    ];
    const createResult = contract.createProjectEscrow(
      accounts.deployer,
      "project1",
      accounts.recipient,
      milestones
    );
    expect(createResult).toEqual({ ok: true, value: true });

    const project = contract.getProjectEscrow("project1").value;
    expect(project).toEqual({
      totalFunded: 0,
      released: 0,
      milestonesCount: 2,
      active: true,
      refundWindowStart: undefined,
      recipient: accounts.recipient,
    });

    const ms1 = contract.getMilestone("project1", 0).value;
    expect(ms1).toEqual(expect.objectContaining({ description: "Milestone 1", releasePercentage: 50, verified: false }));
  });

  it("should allow funding a project", () => {
    contract.createProjectEscrow(accounts.deployer, "project1", accounts.recipient, []);
    const fundResult = contract.fundEscrow(accounts.contributor1, "project1", 1000);
    expect(fundResult).toEqual({ ok: true, value: true });

    const project = contract.getProjectEscrow("project1").value;
    expect(project?.totalFunded).toBe(1000);

    const contrib = contract.getContribution("project1", accounts.contributor1).value;
    expect(contrib?.amount).toBe(1000);
  });

  it("should verify and release milestone funds", () => {
    const milestones = [
      { description: "Milestone 1", targetAmount: 1000, releasePercentage: 100 },
    ];
    contract.createProjectEscrow(accounts.deployer, "project1", accounts.recipient, milestones);
    contract.fundEscrow(accounts.contributor1, "project1", 1000);

    const releaseResult = contract.verifyAndRelease(accounts.deployer, "project1", 0, accounts.oracle);
    expect(releaseResult).toEqual({ ok: true, value: true });

    const project = contract.getProjectEscrow("project1").value;
    expect(project?.released).toBe(1000);

    const ms = contract.getMilestone("project1", 0).value;
    expect(ms?.verified).toBe(true);
  });

  it("should initiate refund window and allow claims", () => {
    contract.createProjectEscrow(accounts.deployer, "project1", accounts.recipient, []);
    contract.fundEscrow(accounts.contributor1, "project1", 1000);

    const initiateResult = contract.initiateRefundWindow(accounts.deployer, "project1");
    expect(initiateResult).toEqual({ ok: true, value: true });

    const claimResult = contract.claimRefund(accounts.contributor1, "project1");
    expect(claimResult).toEqual({ ok: true, value: true });

    const contrib = contract.getContribution("project1", accounts.contributor1).value;
    expect(contrib?.refunded).toBe(true);
  });

  it("should prevent refund after grace period", () => {
    contract.createProjectEscrow(accounts.deployer, "project1", accounts.recipient, []);
    contract.fundEscrow(accounts.contributor1, "project1", 1000);
    contract.initiateRefundWindow(accounts.deployer, "project1");

    for (let i = 0; i < 145; i++) {
      contract.advanceBlock();
    }

    const claimResult = contract.claimRefund(accounts.contributor1, "project1");
    expect(claimResult).toEqual({ ok: false, value: 110 });
  });

  it("should prevent operations when paused", () => {
    contract.createProjectEscrow(accounts.deployer, "project1", accounts.recipient, []);
    contract.pause(accounts.deployer);

    const fundResult = contract.fundEscrow(accounts.contributor1, "project1", 1000);
    expect(fundResult).toEqual({ ok: false, value: 105 });
  });
});