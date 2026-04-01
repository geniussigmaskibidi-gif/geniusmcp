# GeniusMCP Soul — How to Think With Code Intelligence

> This file teaches AI agents how to use GeniusMCP effectively.
> It is not a tool reference. It is a reasoning framework.
> Place it in your project root or reference it from CLAUDE.md.

---

## Who You Become With GeniusMCP

You are not searching — you are **hunting**. The difference:

- Searching = "find files containing rate limiter"
- Hunting = "find the 3 best architectural approaches to rate limiting, score them by durability and importability, explain tradeoffs, and extract the winner with license verification"

GeniusMCP gives you compound intelligence. Every query enriches your memory. Session 10 knows what sessions 1–9 discovered. Use this.

---

## The Five Laws

### 1. Remember Before You Search

```
WRONG: genius.hunt("retry with backoff")
RIGHT: memory.recall("retry") → found 3 patterns from last week → no search needed
```

Always check memory first. If you already found a rate limiter last Tuesday, don't burn API budget finding it again. Memory recall is <10ms. Search is 5-15 seconds.

### 2. Hunt Concepts, Not Strings

```
WRONG: genius.hunt("function retryWithExponentialBackoff")
RIGHT: genius.hunt("retry with exponential backoff")
```

GeniusMCP understands concepts. It expands "retry" into synonyms (backoff, jitter, exponential), generates naming variants (retryWithBackoff, retry_with_backoff, RetryBackoff), and searches across conventions. Give it the **idea**, not the exact code you expect.

### 3. Narrow After Broadening

```
Step 1: genius.hunt("rate limiter", tier: "L1")           → 5 archetypes, 130 tokens
Step 2: genius.explain(repo, path, query, snippet)         → score breakdown
Step 3: import.extract(repo, path, symbol)                 → code with provenance
```

Start wide (L1 tier, many archetypes), then drill into the best candidate. Don't start with L3 — you'll waste context window on code you might not use.

### 4. Trust the Score Breakdown

Every result has a 6-factor breakdown:

| Factor | What It Measures | Weight |
|--------|-----------------|--------|
| **queryFit** | Does the symbol name/signature match your intent? | 35% |
| **durability** | Stars, tests, releases, repo age | part of 50% |
| **vitality** | Recent pushes, not archived, active maintenance | part of 50% |
| **importability** | Few deps, permissive license, compact code | part of 50% |
| **codeQuality** | Self-contained, exported, reasonable size | part of 50% |
| **evidenceConfidence** | How much do we actually know vs guess? | 15% |

When `evidenceConfidence` is low (<0.5), the score is uncertain. Search deeper or check `gaps` field.

### 5. Store What Works, Forget What Doesn't

```
After successful implementation:
  memory.store(name, kind, code, description, tags)

After finding a pattern is outdated:
  memory.forget(patternId)

After improving a pattern:
  memory.evolve(parentId, newName, newCode)
```

The memory grows smarter only if you feed it. Store patterns that passed tests. Evolve patterns you improved. Forget patterns that led to bugs.

---

## Search Strategy Playbook

### "I need to implement X from scratch"

```
1. memory.recall("X")                          → check if already known
2. genius.hunt("X", preset: "teaching_quality") → find clear, well-documented examples
3. genius.explain(best_result)                  → understand why it scored high
4. import.extract(repo, path, symbol)           → get code with license check
5. memory.store(result)                         → remember for next time
```

### "I need to choose between two approaches"

```
1. research.deep_compare("concept", ["repo1/name", "repo2/name"])
   → structured side-by-side: stars, license, CI, matching symbols
2. Look at qualitySignals:
   - popularity: log10(stars)/5
   - maintenance: archived? CI present?
   - licenseOk: MIT/Apache/BSD?
   - hasTests: are there tests?
   - codeFound: did we find relevant code?
```

### "I need to understand unfamiliar code"

```
1. research.archaeology("owner/repo", "aspect")  → find relevant files + symbols
2. github.repo_file("owner/repo", "path")         → read the actual code
3. github.repo_tree("owner/repo")                  → see project structure
4. genius.explain(repo, path, query, snippet)      → score the implementation
```

### "I need to find the best library for Y"

```
1. github.search_repos("Y", language, minStars: 500)  → find candidates
2. research.deep_compare("Y", [top 3 repos])           → structured comparison
3. genius.find_best("Y", preset: "battle_tested")      → deep 8-stage pipeline
4. import.extract(winner)                               → get the code
```

### "I already searched for this before"

```
1. memory.recall("keyword")         → instant, <10ms
2. memory.related(patternId)        → find connected patterns
3. memory.stats()                   → see what's in memory
```

---

## Tool Selection Guide

### When you know WHAT you want:
| Situation | Tool | Why |
|-----------|------|-----|
| "Find implementations of X" | `genius.hunt` | Multi-source, ranked archetypes |
| "Find THE BEST implementation" | `genius.find_best` | 8-stage pipeline, GitHub-focused |
| "Why did this rank #1?" | `genius.explain` | Full signal breakdown |
| "Get this code into my project" | `import.extract` | License + provenance + attribution |

### When you're EXPLORING:
| Situation | Tool | Why |
|-----------|------|-----|
| "What repos exist for X?" | `github.search_repos` | Quick overview with stars/license |
| "What's in this repo?" | `github.repo_tree` + `github.repo_overview` | Structure + metadata |
| "Read this specific file" | `github.repo_file` | Direct file access |
| "How does repo X handle Y?" | `research.archaeology` | Finds relevant files + symbols |
| "Compare A vs B" | `research.deep_compare` | Structured quality comparison |

### When you're REMEMBERING:
| Situation | Tool | Why |
|-----------|------|-----|
| "Did I find this before?" | `memory.recall` | FTS search over past patterns |
| "What do I know?" | `memory.stats` | Total patterns, top confident, most recalled |
| "Save this for later" | `memory.store` | Persistent across sessions |
| "This pattern evolved" | `memory.evolve` | Version with lineage tracking |
| "Find related patterns" | `memory.related` | Graph traversal |

### When you DON'T KNOW what tools exist:
| Situation | Tool | Why |
|-----------|------|-----|
| "What can GeniusMCP do?" | `forge_discover` | Search by intent, not tool name |

---

## Thinking Patterns

### The Compound Intelligence Loop

```
Session 1: Search → Find → Store
Session 2: Recall → Refine → Store evolved version
Session 5: Recall instantly → No search needed
Session 10: Rich memory → Better suggestions → Higher confidence
```

Every interaction makes the next one faster. This is the fundamental advantage over stateless search.

### The Confidence Gradient

```
confidence > 0.8   → Trust it. Use it directly.
confidence 0.5-0.8 → Review it. Check gaps.
confidence < 0.5   → Treat as inspiration, not solution. Search deeper.
```

### The Blind Spot Check

Every hunt result includes `blindSpots`. Common ones:

| Blind Spot | What It Means | What To Do |
|------------|--------------|------------|
| `snippet_only` | We have a code fragment, not the full function | Use `github.repo_file` to get full code |
| `source_timeout` | One or more sources didn't respond in time | Try `mode: "deep"` for longer timeout |
| `metadata_stale` | Repo metadata wasn't hydrated | Scores may be inaccurate |
| `license_unknown` | Couldn't determine license | Check manually before importing |
| `default_branch_only` | Only searched default branch | Feature branches not included |

### The Preset Selector

| If the user wants... | Use preset |
|----------------------|-----------|
| Proven, popular, tested code | `battle_tested` |
| Latest patterns, active repos | `modern_active` |
| Minimal dependencies, copy-paste | `minimal_dependency` |
| Clear, well-documented examples | `teaching_quality` |

---

## Anti-Patterns — What NOT To Do

### Don't search for exact code
```
BAD:  genius.hunt("export async function retryWithExponentialBackoff(fn, maxRetries = 3)")
GOOD: genius.hunt("retry with exponential backoff")
```

### Don't use L3 tier for exploration
```
BAD:  genius.hunt("caching strategies", tier: "L3", maxArchetypes: 10)
      → 10 full code blocks = 5000+ tokens wasted
GOOD: genius.hunt("caching strategies", tier: "L1", maxArchetypes: 10)
      → 10 compact cards = 300 tokens, then drill into best one
```

### Don't skip memory
```
BAD:  genius.hunt("rate limiter") every single time
GOOD: memory.recall("rate limiter") → found? use it. not found? hunt.
```

### Don't ignore the score breakdown
```
BAD:  Pick first result because it's #1
GOOD: Check breakdown. High queryFit but low durability? Maybe #2 is better for production.
```

### Don't import without checking license
```
BAD:  import.extract(repo, path) → paste code → ship
GOOD: Check licenseVerdict in the response. "review" = talk to the user. "blocked" = don't use it.
```

---

## Token Budget Awareness

GeniusMCP is designed to minimize your context window consumption:

| Tier | Tokens per result | When to use |
|------|-------------------|-------------|
| L1 | ~25 | Exploration: "what exists?" |
| L2 | ~80 | Evaluation: "which is best?" |
| L3 | ~400 | Implementation: "show me the code" |

**The optimal workflow burns ~500 tokens total:**
1. L1 hunt (5 results × 25 = 125 tokens)
2. Explain top 1 (100 tokens)
3. Import extract (275 tokens for code + provenance)

Compare to naive approach: read 10 GitHub files × 500 tokens = 5000 tokens.

---

## The Soul of GeniusMCP

GeniusMCP exists because AI agents waste 80% of their token budget on context gathering instead of reasoning. Every tool in GeniusMCP is designed to compress the gap between "I need X" and "here is the best X, scored, explained, and license-checked."

Your job as an agent is not to search. It is to **decide**. GeniusMCP gives you the evidence. You make the judgment.

Three things to always remember:
1. **Memory first** — don't re-discover what you already know
2. **Tier up gradually** — L1 to explore, L3 only for the winner
3. **Trust the signals** — scores are decomposable, gaps are explicit, blind spots are named

The best search is the one you don't have to make.
