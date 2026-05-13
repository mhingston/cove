import type { PermissionTier } from './permissions.ts';

export interface ArgCondition {
  key: string;
  matches?: string;
  pattern?: string;
  exists?: boolean;
}

export interface DynamicRule {
  name: string;
  toolName: string;
  condition: ArgCondition;
  tier: PermissionTier;
}

export interface ToolPermissionConfig {
  defaultTier: PermissionTier;
  overrides?: Record<string, PermissionTier>;
  dynamicRules?: DynamicRule[];
}

const DEFAULT_OVERRIDES: Record<string, PermissionTier> = {
  read: 'auto',
  glob: 'auto',
  grep: 'auto',
  bash: 'confirm',
  write: 'prompt',
};

const DEFAULT_DYNAMIC_RULES: DynamicRule[] = [
  {
    name: 'git-safe',
    toolName: 'bash',
    condition: { key: 'command', pattern: '^git\\s+(status|diff|log|show|branch|rev-parse|merge-base)(\\s|$)' },
    tier: 'auto',
  },
  {
    name: 'rm-dangerous',
    toolName: 'bash',
    condition: { key: 'command', pattern: '\\brm\\b' },
    tier: 'confirm',
  },
];

const PERMISSION_TIER_PRIORITY: Record<PermissionTier, number> = {
  auto: 0,
  prompt: 1,
  confirm: 2,
};

export class PolicyEngine {
  private config: ToolPermissionConfig;
  private sessionOverrides = new Map<string, PermissionTier>();

  constructor(config?: Partial<ToolPermissionConfig>) {
    this.config = {
      defaultTier: config?.defaultTier ?? 'prompt',
      overrides: { ...DEFAULT_OVERRIDES, ...config?.overrides },
      dynamicRules: config?.dynamicRules ?? DEFAULT_DYNAMIC_RULES,
    };
  }

  setSessionOverride(toolName: string, tier: PermissionTier): void {
    this.sessionOverrides.set(toolName, tier);
  }

  clearSessionOverride(toolName: string): void {
    this.sessionOverrides.delete(toolName);
  }

  clearSessionOverrides(): void {
    this.sessionOverrides.clear();
  }

  getSessionOverrides(): Record<string, PermissionTier> {
    return Object.fromEntries(this.sessionOverrides);
  }

  evaluateCondition(condition: ArgCondition, args: Record<string, unknown>): boolean {
    const value = args[condition.key];

    if (condition.matches !== undefined) {
      return value === condition.matches;
    }

    if (condition.pattern !== undefined) {
      return typeof value === 'string' && new RegExp(condition.pattern).test(value);
    }

    if (condition.exists !== undefined) {
      return condition.exists ? value !== undefined : value === undefined;
    }

    return false;
  }

  getEffectiveTier(toolName: string, args?: Record<string, unknown>): PermissionTier {
    const sessionTier = this.sessionOverrides.get(toolName);

    if (sessionTier !== undefined) {
      return sessionTier;
    }

    if (args != null && this.config.dynamicRules != null) {
      let matchedTier: PermissionTier | undefined;

      for (const rule of this.config.dynamicRules) {
        if (rule.toolName !== toolName || !this.evaluateCondition(rule.condition, args)) {
          continue;
        }

        if (
          matchedTier === undefined
          || PERMISSION_TIER_PRIORITY[rule.tier] > PERMISSION_TIER_PRIORITY[matchedTier]
        ) {
          matchedTier = rule.tier;
        }
      }

      if (matchedTier !== undefined) {
        return matchedTier;
      }
    }

    return this.config.overrides?.[toolName] ?? this.config.defaultTier;
  }
}
