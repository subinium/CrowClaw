import type { ConversationMessage, SessionState } from './index.js';

export interface ConversationBranch {
  id: string;
  parentBranchId: string | null;
  forkPoint: number; // message index where this branch diverges
  label?: string;
  createdAt: string;
  messages: ConversationMessage[];
  metadata?: Record<string, unknown>;
}

export interface BranchComparison {
  branchA: { id: string; label?: string; messageCount: number; finalResponse?: string };
  branchB: { id: string; label?: string; messageCount: number; finalResponse?: string };
  sharedMessageCount: number;
  divergencePoint: number;
}

export class ConversationTree {
  private branches = new Map<string, ConversationBranch>();
  private readonly rootId: string;

  constructor(rootSession: SessionState) {
    this.rootId = `root-${rootSession.sessionId}`;
    this.branches.set(this.rootId, {
      id: this.rootId,
      parentBranchId: null,
      forkPoint: 0,
      label: 'main',
      createdAt: rootSession.updatedAt,
      messages: [...rootSession.messages],
    });
  }

  /**
   * Fork the conversation at a specific message index.
   * Returns a new branch with messages up to (but not including) forkPoint,
   * ready for the user to take a different approach.
   */
  fork(fromBranchId: string, forkPoint?: number, label?: string): ConversationBranch {
    const parent = this.branches.get(fromBranchId);
    if (!parent) {
      throw new Error(`Branch not found: ${fromBranchId}`);
    }

    const point = forkPoint ?? parent.messages.length;
    if (point < 0 || point > parent.messages.length) {
      throw new Error(
        `Invalid fork point ${point}: branch has ${parent.messages.length} message(s)`,
      );
    }

    const branchId = `branch-${crypto.randomUUID().slice(0, 8)}`;
    const branch: ConversationBranch = {
      id: branchId,
      parentBranchId: fromBranchId,
      forkPoint: point,
      label,
      createdAt: new Date().toISOString(),
      messages: parent.messages.slice(0, point),
    };

    this.branches.set(branchId, branch);
    return branch;
  }

  /** Add a message to a specific branch. */
  addMessage(branchId: string, message: ConversationMessage): void {
    const branch = this.branches.get(branchId);
    if (!branch) {
      throw new Error(`Branch not found: ${branchId}`);
    }
    branch.messages.push(message);
  }

  /** Get a branch by ID. */
  getBranch(branchId: string): ConversationBranch | null {
    return this.branches.get(branchId) ?? null;
  }

  /** List all branches. */
  listBranches(): ConversationBranch[] {
    return [...this.branches.values()];
  }

  /** Compare two branches side-by-side. */
  compare(branchAId: string, branchBId: string): BranchComparison {
    const a = this.branches.get(branchAId);
    const b = this.branches.get(branchBId);
    if (!a || !b) {
      throw new Error(`Branch not found: ${!a ? branchAId : branchBId}`);
    }

    let shared = 0;
    const minLen = Math.min(a.messages.length, b.messages.length);
    for (let i = 0; i < minLen; i++) {
      if (
        a.messages[i].content === b.messages[i].content &&
        a.messages[i].role === b.messages[i].role
      ) {
        shared++;
      } else {
        break;
      }
    }

    return {
      branchA: {
        id: a.id,
        label: a.label,
        messageCount: a.messages.length,
        finalResponse: findLastAssistantMessage(a.messages),
      },
      branchB: {
        id: b.id,
        label: b.label,
        messageCount: b.messages.length,
        finalResponse: findLastAssistantMessage(b.messages),
      },
      sharedMessageCount: shared,
      divergencePoint: shared,
    };
  }

  /**
   * Merge a branch back: append its unique messages after the fork point to the target.
   * A system message is inserted as a merge marker.
   */
  merge(sourceBranchId: string, targetBranchId: string): ConversationBranch {
    const source = this.branches.get(sourceBranchId);
    const target = this.branches.get(targetBranchId);
    if (!source || !target) {
      throw new Error(`Branch not found: ${!source ? sourceBranchId : targetBranchId}`);
    }

    const uniqueMessages = source.messages.slice(source.forkPoint);
    const mergeNote: ConversationMessage = {
      role: 'system',
      content: `[Merged ${uniqueMessages.length} message(s) from branch "${source.label ?? source.id}"]`,
      createdAt: new Date().toISOString(),
      metadata: { mergedFrom: source.id, mergedMessages: uniqueMessages.length },
    };

    target.messages.push(mergeNote, ...uniqueMessages);
    return target;
  }

  /** Delete a branch. Cannot delete the root branch. */
  deleteBranch(branchId: string): boolean {
    if (branchId === this.rootId) {
      throw new Error('Cannot delete the root branch');
    }
    return this.branches.delete(branchId);
  }

  /** Get the tree structure for visualization. */
  getTreeStructure(): Array<{
    id: string;
    parentId: string | null;
    label?: string;
    messageCount: number;
    forkPoint: number;
  }> {
    return [...this.branches.values()].map(b => ({
      id: b.id,
      parentId: b.parentBranchId,
      label: b.label,
      messageCount: b.messages.length,
      forkPoint: b.forkPoint,
    }));
  }

  getRootId(): string {
    return this.rootId;
  }
}

function findLastAssistantMessage(messages: ConversationMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') {
      return messages[i].content;
    }
  }
  return undefined;
}
