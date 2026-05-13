import type { PolicyEngine } from './policy.ts';

export type PermissionTier = 'auto' | 'prompt' | 'confirm';

export interface PermissionRequest {
  toolName: string;
  args: Record<string, unknown>;
  tier: PermissionTier;
  id: string;
  timestamp: number;
  context?: string;
}

export type ApprovalResult = 'approved' | 'declined';

export type ApprovalHandler = (request: PermissionRequest) => Promise<ApprovalResult>;

export interface PermissionBridge {
  check(toolName: string, args: Record<string, unknown>): Promise<boolean>;
  getTier(toolName: string, args?: Record<string, unknown>): PermissionTier;
  setSessionOverride(toolName: string, tier: PermissionTier): void;
  clearSessionOverride(toolName: string): void;
  clearSessionOverrides(): void;
  getSessionOverrides(): Record<string, PermissionTier>;
  setApprovalHandler(handler: ApprovalHandler): void;
  requestApproval(request: PermissionRequest, autoApprove?: boolean): Promise<ApprovalResult>;
}

const BUILTIN_TOOL_TIERS: Record<string, PermissionTier> = {
  read: 'auto',
  glob: 'auto',
  grep: 'auto',
  bash: 'confirm',
  write: 'prompt',
};

export class PermissionBridgeImpl implements PermissionBridge {
  private sessionOverrides = new Map<string, PermissionTier>();
  private handler?: ApprovalHandler;
  private requestCounter = 0;
  private toolTiers: Record<string, PermissionTier>;
  private policy?: PolicyEngine;

  constructor(options?: { toolTiers?: Record<string, PermissionTier>; policy?: PolicyEngine }) {
    this.toolTiers = { ...BUILTIN_TOOL_TIERS, ...options?.toolTiers };
    this.policy = options?.policy;
  }

  setSessionOverride(toolName: string, tier: PermissionTier): void {
    if (this.policy != null) {
      this.policy.setSessionOverride(toolName, tier);
      return;
    }

    this.sessionOverrides.set(toolName, tier);
  }

  clearSessionOverride(toolName: string): void {
    if (this.policy != null) {
      this.policy.clearSessionOverride(toolName);
      return;
    }

    this.sessionOverrides.delete(toolName);
  }

  clearSessionOverrides(): void {
    if (this.policy != null) {
      this.policy.clearSessionOverrides();
      return;
    }

    this.sessionOverrides.clear();
  }

  getSessionOverrides(): Record<string, PermissionTier> {
    if (this.policy != null) {
      return this.policy.getSessionOverrides();
    }

    return Object.fromEntries(this.sessionOverrides);
  }

  getTier(toolName: string, args?: Record<string, unknown>): PermissionTier {
    if (this.policy != null) {
      return this.policy.getEffectiveTier(toolName, args);
    }

    const sessionTier = this.sessionOverrides.get(toolName);

    if (sessionTier !== undefined) {
      return sessionTier;
    }

    return this.toolTiers[toolName] ?? 'prompt';
  }

  setApprovalHandler(handler: ApprovalHandler): void {
    this.handler = handler;
  }

  async check(toolName: string, args: Record<string, unknown>): Promise<boolean> {
    const tier = this.getTier(toolName, args);

    if (tier === 'auto') {
      return true;
    }

    if (this.handler == null) {
      throw new Error(
        `No approval handler set. Cannot check permission for '${toolName}' (tier: ${tier}). Call setApprovalHandler() first.`,
      );
    }

    const result = await this.handler({
      toolName,
      args,
      tier,
      id: `perm-${++this.requestCounter}`,
      timestamp: Date.now(),
    });

    return result === 'approved';
  }

  async requestApproval(request: PermissionRequest, autoApprove?: boolean): Promise<ApprovalResult> {
    if (autoApprove) {
      return 'approved';
    }

    if (this.handler == null) {
      throw new Error(
        `No approval handler set. Cannot request approval for '${request.toolName}'. Call setApprovalHandler() first.`,
      );
    }

    return this.handler(request);
  }
}
