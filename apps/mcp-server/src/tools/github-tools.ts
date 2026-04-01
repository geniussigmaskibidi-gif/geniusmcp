// @ts-nocheck
import {
  buildForgeTool,
  err,
  ok,
  type ForgeResult,
  type ForgeTool,
  type ForgeToolContext,
} from '@forgemcp/core/tool-factory';
import { checkRateBudget } from '@forgemcp/core/tool-permissions';

function parseRepoRef(repoRef: string): { owner: string; repo: string } | null {
  const [owner, repo] = repoRef.split('/');
  return owner && repo ? { owner, repo } : null;
}

function createGitHubReadTool<TInput extends object, TOutput>(
  name: string,
  description: string,
  inputSchema: Readonly<Record<string, unknown>>,
  bucket: 'core' | 'search' | 'code_search' | 'graphql',
  execute: (input: TInput, ctx: ForgeToolContext) => Promise<ForgeResult<TOutput>>,
): ForgeTool<TInput, TOutput> {
  return buildForgeTool<TInput, TOutput>({
    name,
    description,
    category: 'github',
    inputSchema,
    tags: ['github', 'read-only'],
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    checkPermissions: (input, ctx) => checkRateBudget(input, ctx, bucket, bucket === 'code_search' ? 2 : 1),
    execute,
  });
}

export function createGitHubTools(): ForgeTool<object, unknown>[] {
  const searchReposTool = createGitHubReadTool<{ query: string }, Readonly<Record<string, unknown>>>(
    'github.search_repos',
    'Search GitHub repositories with rate-budget awareness.',
    { type: 'object', required: ['query'], properties: { query: { type: 'string' } } },
    'search',
    async (input, ctx) => {
      const gateway = ctx.services.gitHubGateway;
      if (!gateway) return err('SERVICE_UNAVAILABLE', 'GitHub gateway is required');
      const result = await gateway.searchRepos(input.query);
      return result.ok ? ok({ repos: result.value }) : result;
    },
  );

  const searchCodeTool = createGitHubReadTool<{ query: string }, Readonly<Record<string, unknown>>>(
    'github.search_code',
    'Search GitHub code with the dedicated code-search budget.',
    { type: 'object', required: ['query'], properties: { query: { type: 'string' } } },
    'code_search',
    async (input, ctx) => {
      const gateway = ctx.services.gitHubGateway;
      if (!gateway) return err('SERVICE_UNAVAILABLE', 'GitHub gateway is required');
      const result = await gateway.searchCode(input.query);
      return result.ok ? ok({ hits: result.value }) : result;
    },
  );

  const repoOverviewTool = createGitHubReadTool<{ repo: string }, Readonly<Record<string, unknown>>>(
    'github.repo_overview',
    'Fetch a repository overview with stars, license, activity, and quality hints.',
    { type: 'object', required: ['repo'], properties: { repo: { type: 'string' } } },
    'core',
    async (input, ctx) => {
      const gateway = ctx.services.gitHubGateway;
      const parsed = parseRepoRef(input.repo);
      if (!gateway || !parsed) return err('INVALID_INPUT', 'Provide repo as owner/name');
      const result = await gateway.getRepoOverview(parsed.owner, parsed.repo);
      return result.ok ? ok({ repo: result.value }) : result;
    },
  );

  const repoFileTool = createGitHubReadTool<{ repo: string; path: string; ref?: string }, Readonly<Record<string, unknown>>>(
    'github.repo_file',
    'Fetch the content of a repository file.',
    { type: 'object', required: ['repo', 'path'], properties: { repo: { type: 'string' }, path: { type: 'string' }, ref: { type: 'string' } } },
    'core',
    async (input, ctx) => {
      const gateway = ctx.services.gitHubGateway;
      const parsed = parseRepoRef(input.repo);
      if (!gateway || !parsed) return err('INVALID_INPUT', 'Provide repo as owner/name');
      const result = await gateway.getFileContent(parsed.owner, parsed.repo, input.path, input.ref);
      return result.ok ? ok({ repo: input.repo, path: input.path, content: result.value }) : result;
    },
  );

  const repoTreeTool = createGitHubReadTool<{ repo: string; ref?: string }, Readonly<Record<string, unknown>>>(
    'github.repo_tree',
    'Fetch a repository tree listing.',
    { type: 'object', required: ['repo'], properties: { repo: { type: 'string' }, ref: { type: 'string' } } },
    'core',
    async (input, ctx) => {
      const gateway = ctx.services.gitHubGateway;
      const parsed = parseRepoRef(input.repo);
      if (!gateway || !parsed) return err('INVALID_INPUT', 'Provide repo as owner/name');
      const result = await gateway.getTree(parsed.owner, parsed.repo, input.ref);
      return result.ok ? ok({ repo: input.repo, entries: result.value }) : result;
    },
  );

  const repoLanguagesTool = createGitHubReadTool<{ repo: string }, Readonly<Record<string, unknown>>>(
    'github.repo_languages',
    'Fetch a language breakdown for a repo.',
    { type: 'object', required: ['repo'], properties: { repo: { type: 'string' } } },
    'core',
    async (input, ctx) => {
      const gateway = ctx.services.gitHubGateway;
      const parsed = parseRepoRef(input.repo);
      if (!gateway || !parsed) return err('INVALID_INPUT', 'Provide repo as owner/name');
      if (gateway.getRepoLanguages) {
        const result = await gateway.getRepoLanguages(parsed.owner, parsed.repo);
        return result.ok ? ok({ repo: input.repo, languages: result.value }) : result;
      }
      const overview = await gateway.getRepoOverview(parsed.owner, parsed.repo);
      return overview.ok ? ok({ repo: input.repo, languages: overview.value.languageStats ?? { [overview.value.primaryLanguage ?? 'unknown']: 1 } }) : overview;
    },
  );

  const repoContributorsTool = createGitHubReadTool<{ repo: string }, Readonly<Record<string, unknown>>>(
    'github.repo_contributors',
    'Fetch contributor information, preferring GraphQL hydration when available.',
    { type: 'object', required: ['repo'], properties: { repo: { type: 'string' } } },
    'graphql',
    async (input, ctx) => {
      const gateway = ctx.services.gitHubGateway;
      const parsed = parseRepoRef(input.repo);
      if (!gateway || !parsed) return err('INVALID_INPUT', 'Provide repo as owner/name');
      if (gateway.getRepoContributors) {
        const result = await gateway.getRepoContributors(parsed.owner, parsed.repo);
        return result.ok ? ok({ repo: input.repo, contributors: result.value }) : result;
      }
      const overview = await gateway.getRepoOverview(parsed.owner, parsed.repo);
      return overview.ok ? ok({ repo: input.repo, contributors: [], contributorCount: 0 }) : overview;
    },
  );

  const repoReleasesTool = createGitHubReadTool<{ repo: string }, Readonly<Record<string, unknown>>>(
    'github.repo_releases',
    'Fetch repository releases.',
    { type: 'object', required: ['repo'], properties: { repo: { type: 'string' } } },
    'core',
    async (input, ctx) => {
      const gateway = ctx.services.gitHubGateway;
      const parsed = parseRepoRef(input.repo);
      if (!gateway || !parsed) return err('INVALID_INPUT', 'Provide repo as owner/name');
      if (!gateway.getRepoReleases) {
        return err('NOT_SUPPORTED', 'Release listing is not available on the configured gateway');
      }
      const result = await gateway.getRepoReleases(parsed.owner, parsed.repo);
      return result.ok ? ok({ repo: input.repo, releases: result.value }) : result;
    },
  );

  const repoIssuesTool = createGitHubReadTool<{ repo: string; state?: string }, Readonly<Record<string, unknown>>>(
    'github.repo_issues',
    'Fetch repository issues.',
    { type: 'object', required: ['repo'], properties: { repo: { type: 'string' }, state: { type: 'string' } } },
    'search',
    async (input, ctx) => {
      const gateway = ctx.services.gitHubGateway;
      const parsed = parseRepoRef(input.repo);
      if (!gateway || !parsed) return err('INVALID_INPUT', 'Provide repo as owner/name');
      if (gateway.getRepoIssues) {
        const result = await gateway.getRepoIssues(parsed.owner, parsed.repo, input.state);
        return result.ok ? ok({ repo: input.repo, issues: result.value }) : result;
      }
      if (gateway.searchIssues) {
        const result = await gateway.searchIssues(`repo:${input.repo} state:${input.state ?? 'open'}`);
        return result.ok ? ok({ repo: input.repo, issues: result.value }) : result;
      }
      return err('NOT_SUPPORTED', 'Issue listing is not available on the configured gateway');
    },
  );

  const repoPullsTool = createGitHubReadTool<{ repo: string; state?: string }, Readonly<Record<string, unknown>>>(
    'github.repo_pulls',
    'Fetch repository pull requests.',
    { type: 'object', required: ['repo'], properties: { repo: { type: 'string' }, state: { type: 'string' } } },
    'search',
    async (input, ctx) => {
      const gateway = ctx.services.gitHubGateway;
      const parsed = parseRepoRef(input.repo);
      if (!gateway || !parsed) return err('INVALID_INPUT', 'Provide repo as owner/name');
      if (gateway.getRepoPulls) {
        const result = await gateway.getRepoPulls(parsed.owner, parsed.repo, input.state);
        return result.ok ? ok({ repo: input.repo, pulls: result.value }) : result;
      }
      if (gateway.searchPullRequests) {
        const result = await gateway.searchPullRequests(`repo:${input.repo} state:${input.state ?? 'open'}`);
        return result.ok ? ok({ repo: input.repo, pulls: result.value }) : result;
      }
      return err('NOT_SUPPORTED', 'Pull request listing is not available on the configured gateway');
    },
  );

  const repoActionsTool = createGitHubReadTool<{ repo: string }, Readonly<Record<string, unknown>>>(
    'github.repo_actions',
    'Fetch repository actions/workflow information.',
    { type: 'object', required: ['repo'], properties: { repo: { type: 'string' } } },
    'core',
    async (input, ctx) => {
      const gateway = ctx.services.gitHubGateway;
      const parsed = parseRepoRef(input.repo);
      if (!gateway || !parsed) return err('INVALID_INPUT', 'Provide repo as owner/name');
      if (!gateway.getRepoActions) {
        return err('NOT_SUPPORTED', 'Actions listing is not available on the configured gateway');
      }
      const result = await gateway.getRepoActions(parsed.owner, parsed.repo);
      return result.ok ? ok({ repo: input.repo, actions: result.value }) : result;
    },
  );

  const compareReposTool = createGitHubReadTool<{ repos: string[] }, Readonly<Record<string, unknown>>>(
    'github.compare_repos',
    'Hydrate multiple repos in parallel and compare their core stats.',
    { type: 'object', required: ['repos'], properties: { repos: { type: 'array', items: { type: 'string' } } } },
    'core',
    async (input, ctx) => {
      const gateway = ctx.services.gitHubGateway;
      if (!gateway) return err('SERVICE_UNAVAILABLE', 'GitHub gateway is required');
      if (gateway.compareRepos) {
        const result = await gateway.compareRepos(input.repos);
        return result.ok ? ok({ rows: result.value }) : result;
      }
      const rows = await Promise.all(
        input.repos.map(async (repoRef) => {
          const parsed = parseRepoRef(repoRef);
          if (!parsed) return { repo: repoRef, error: 'invalid repo ref' };
          const overview = await gateway.getRepoOverview(parsed.owner, parsed.repo);
          return overview.ok ? overview.value : { repo: repoRef, error: overview.error.message };
        }),
      );
      return ok({ rows });
    },
  );

  const trendingReposTool = createGitHubReadTool<{ language?: string; since?: string }, Readonly<Record<string, unknown>>>(
    'github.trending_repos',
    'Fetch trending repositories or fall back to search heuristics.',
    { type: 'object', properties: { language: { type: 'string' }, since: { type: 'string' } } },
    'search',
    async (input, ctx) => {
      const gateway = ctx.services.gitHubGateway;
      if (!gateway) return err('SERVICE_UNAVAILABLE', 'GitHub gateway is required');
      if (gateway.getTrendingRepos) {
        const result = await gateway.getTrendingRepos(input.language, input.since);
        return result.ok ? ok({ repos: result.value }) : result;
      }
      const result = await gateway.searchRepos(`stars:>100 sort:stars-desc${input.language ? ` language:${input.language}` : ''}`);
      return result.ok ? ok({ repos: result.value }) : result;
    },
  );

  const dependencyGraphTool = createGitHubReadTool<{ repo: string }, Readonly<Record<string, unknown>>>(
    'github.dependency_graph',
    'Fetch dependency graph data for a repository.',
    { type: 'object', required: ['repo'], properties: { repo: { type: 'string' } } },
    'core',
    async (input, ctx) => {
      const gateway = ctx.services.gitHubGateway;
      const parsed = parseRepoRef(input.repo);
      if (!gateway || !parsed) return err('INVALID_INPUT', 'Provide repo as owner/name');
      if (!gateway.getDependencyGraph) {
        return err('NOT_SUPPORTED', 'Dependency graph is not available on the configured gateway');
      }
      const result = await gateway.getDependencyGraph(parsed.owner, parsed.repo);
      return result.ok ? ok({ repo: input.repo, dependencies: result.value }) : result;
    },
  );

  const securityAdvisoriesTool = createGitHubReadTool<{ query: string }, Readonly<Record<string, unknown>>>(
    'github.security_advisories',
    'Search GitHub security advisories.',
    { type: 'object', required: ['query'], properties: { query: { type: 'string' } } },
    'search',
    async (input, ctx) => {
      const gateway = ctx.services.gitHubGateway;
      if (!gateway) return err('SERVICE_UNAVAILABLE', 'GitHub gateway is required');
      if (!gateway.getSecurityAdvisories) {
        return err('NOT_SUPPORTED', 'Security advisories are not available on the configured gateway');
      }
      const result = await gateway.getSecurityAdvisories(input.query);
      return result.ok ? ok({ advisories: result.value }) : result;
    },
  );

  return [
    searchReposTool,
    searchCodeTool,
    repoOverviewTool,
    repoFileTool,
    repoTreeTool,
    repoLanguagesTool,
    repoContributorsTool,
    repoReleasesTool,
    repoIssuesTool,
    repoPullsTool,
    repoActionsTool,
    compareReposTool,
    trendingReposTool,
    dependencyGraphTool,
    securityAdvisoriesTool,
  ] as ForgeTool<object, unknown>[];
}
