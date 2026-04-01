import type { ForgeTool } from '@forgemcp/core/tool-factory';
import { createDiscoveryTools } from './tools/discovery-tools.js';
import { createEvidenceTools } from './tools/evidence-tools.js';
import { createGitHubTools } from './tools/github-tools.js';
import { createImportTools } from './tools/import-tools.js';
import { createMemoryTools } from './tools/memory-tools.js';
import { createNavigationTools } from './tools/navigation-tools.js';
import { createResearchTools } from './tools/research-tools.js';
import { createSystemTools } from './tools/system-tools.js';

export interface ForgeToolRegistry {
  readonly all: readonly ForgeTool[];
  readonly byName: ReadonlyMap<string, ForgeTool>;
  readonly byCategory: ReadonlyMap<string, readonly ForgeTool[]>;
}

export function createForgeToolRegistry(): ForgeToolRegistry {
  const grouped = new Map<string, ForgeTool[]>([
    ['discovery', createDiscoveryTools()],
    ['memory', createMemoryTools()],
    ['navigation', createNavigationTools()],
    ['github', createGitHubTools()],
    ['import', createImportTools()],
    ['research', createResearchTools()],
    ['system', createSystemTools()],
    ['evidence', createEvidenceTools()],
  ]);

  const all = [...grouped.values()].flat();
  const byName = new Map<string, ForgeTool>();
  for (const tool of all) {
    if (byName.has(tool.name)) {
      throw new Error(`Duplicate tool: ${tool.name}`);
    }
    byName.set(tool.name, tool);
  }
  return {
    all,
    byName,
    byCategory: new Map([...grouped.entries()].map(([cat, tools]) => [cat, tools as readonly ForgeTool[]])),
  };
}
