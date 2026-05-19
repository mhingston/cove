import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const COVE_SKILL_DIR = join(process.env.PI_CODING_AGENT_DIR ?? "/app/session/.pi-agent", "generated", "cove");
const COVE_SKILL_FILE = join(COVE_SKILL_DIR, "cove", "SKILL.md");

function buildCoveSkill(hasGateway: boolean): string {
  const gatewaySection = hasGateway
    ? `

## OneCLI Gateway (Available)
When OneCLI gateway is active, HTTP requests to configured hosts will automatically receive injected credentials. Store secrets with:
- \`onecli secrets create --name '<name>' --type generic --value '<key>' --host-pattern '<domain>'\`
- Credentials are injected at the proxy layer - the agent never sees raw keys.`
    : "";

  return `---
name: cove
description: Cove runtime - persistent knowledge management, memory, and API integration
---

# Cove Runtime

Cove provides tools for durable AI agent sessions with persistent storage.

## Wiki (Long-term Memory)
Wiki entries persist across sessions and are searchable.
- \`wiki_search\` - Search wiki by query (slug, title, content, tags)
- \`wiki_get\` - Get specific entry by slug
- \`wiki_save\` - Create or update a wiki entry (slug, title, content, tags)

## Memories (Session Memory)
Memories are embedded and auto-recalled based on relevance to conversation.
- \`memory_search\` - Search stored memories by query
- \`memory_store\` - Store an important fact or piece of knowledge

## Context Tools
File and code search within the session workspace.
- \`ctx_read\` - Read file contents
- \`ctx_grep\` - Search files by pattern
- \`ctx_bash\` / \`ctx_shell\` - Run shell commands

## Schedules (Future)
Scheduled task execution for automation.

## Best Practices
- Store canonical knowledge in wiki for cross-session recall
- Use memories for automatic relevance-based retrieval
- Wiki entries survive container restarts; memories are session-scoped
- Set tool permissions to "auto" in agent config to skip confirmations${gatewaySection}
`;
}

async function regenerateSkill(hasGateway: boolean): Promise<string> {
  const content = buildCoveSkill(hasGateway);
  await mkdir(COVE_SKILL_FILE.replace("/SKILL.md", ""), { recursive: true });
  await writeFile(COVE_SKILL_FILE, content, "utf8");
  return join(COVE_SKILL_DIR, "cove");
}

function hasOneCliGateway(): boolean {
  return Boolean(
    process.env.ONECLI_AGENT_NAME?.trim() &&
    process.env.ONECLI_URL?.trim()
  );
}

export default function (pi: ExtensionAPI) {
  pi.on("resources_discover", async () => {
    if (!process.env.PI_CODING_AGENT_DIR) return undefined;
    try {
      const skillDir = await regenerateSkill(hasOneCliGateway());
      return { skillPaths: [skillDir] };
    } catch {
      return undefined;
    }
  });
}
