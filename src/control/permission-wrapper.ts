import type { ApprovalStore } from './approvals.ts';
import type { ApprovalResult, PermissionRequest } from './permissions.ts';
import type { PermissionBridgeImpl } from './permissions.ts';

export interface WrappedToolResult {
  content: string;
  permission?: string;
}

function buildPromptMessage(toolName: string): string {
  return `Tool '${toolName}' requires confirmation from the user before it can run.`;
}

function buildPendingApprovalMessage(toolName: string): string {
  return `Tool '${toolName}' is pending approval and will not run until the approvals API confirms it.`;
}

export class PermissionToolWrapper {
  constructor(
    private bridge: PermissionBridgeImpl,
    private approvalStore: ApprovalStore,
  ) {
    void this.approvalStore;
  }

  wrapTool(
    toolName: string,
    toolFn: (params: Record<string, unknown>) => Promise<{ content: string }>,
  ): (params: Record<string, unknown>) => Promise<WrappedToolResult> {
    return async (params: Record<string, unknown>): Promise<WrappedToolResult> => {
      const tier = this.bridge.getTier(toolName, params);

      if (tier === 'auto') {
        const result = await toolFn(params);
        return { ...result, permission: 'auto' };
      }

      if (tier === 'prompt') {
        await this.bridge.check(toolName, params);
        return { content: buildPromptMessage(toolName), permission: 'prompt' };
      }

      const allowed = await this.bridge.check(toolName, params);

      if (!allowed) {
        return { content: buildPendingApprovalMessage(toolName), permission: 'pending' };
      }

      const result = await toolFn(params);
      return { ...result, permission: 'approved' };
    };
  }
}

export function createPermissionHandler(
  approvalStore: ApprovalStore,
  agentGroupId: string,
  sessionId: string,
): (request: PermissionRequest) => Promise<ApprovalResult> {
  return async (request: PermissionRequest): Promise<ApprovalResult> => {
    if (request.tier === 'auto') {
      return 'declined';
    }

    if (request.tier === 'confirm') {
      approvalStore.create({
        agent_group_id: agentGroupId,
        session_id: sessionId,
        tool_name: request.toolName,
        tool_args: request.args,
      });
    }

    return 'declined';
  };
}
