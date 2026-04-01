// Multi-armed bandit that learns which search sources produce
// the best results for each query class.
//
// Design decisions:
// 1. Beta(α,β) prior per (queryClass, source) — conjugate prior for Bernoulli
// 2. Discounting window: halve α,β every 500 queries for non-stationarity
//    (source quality changes over time — rate limits, index freshness)
// 3. Select top-k sources, not just one — hedge against uncertainty
//
// Reference: "An Empirical Evaluation of Thompson Sampling" (Chapelle & Li, NeurIPS 2011)

export interface SourceSelectorConfig {
  readonly sources: readonly string[];
  readonly queryClasses: readonly string[];
  /** Halve α,β every N queries to forget stale observations (default 500) */
  readonly discountInterval?: number;
}

export class SourceSelector {
  private alphas: Map<string, Map<string, number>> = new Map();
  private betas: Map<string, Map<string, number>> = new Map();
  private totalUpdates = 0;
  private readonly discountInterval: number;

  constructor(config: SourceSelectorConfig) {
    this.discountInterval = config.discountInterval ?? 500;

    for (const qc of config.queryClasses) {
      const aMap = new Map<string, number>();
      const bMap = new Map<string, number>();
      for (const src of config.sources) {
        aMap.set(src, 1);
        bMap.set(src, 1);
      }
      this.alphas.set(qc, aMap);
      this.betas.set(qc, bMap);
    }
  }

  // Samples from Beta(α,β) for each source, returns k highest samples
  selectSources(queryClass: string, k: number = 2): string[] {
    const aMap = this.alphas.get(queryClass);
    const bMap = this.betas.get(queryClass);
    if (!aMap || !bMap) {
      const allSources = new Set<string>();
      for (const m of this.alphas.values()) {
        for (const key of m.keys()) allSources.add(key);
      }
      return [...allSources].slice(0, k);
    }

    const samples: Array<{ source: string; sample: number }> = [];
    for (const [source, alpha] of aMap) {
      const beta = bMap.get(source) ?? 1;
      samples.push({ source, sample: betaSample(alpha, beta) });
    }

    return samples
      .sort((a, b) => b.sample - a.sample)
      .slice(0, k)
      .map((s) => s.source);
  }

  update(queryClass: string, source: string, hadRelevantResults: boolean): void {
    const aMap = this.alphas.get(queryClass);
    const bMap = this.betas.get(queryClass);
    if (!aMap || !bMap) return;

    if (hadRelevantResults) {
      aMap.set(source, (aMap.get(source) ?? 1) + 1);
    } else {
      bMap.set(source, (bMap.get(source) ?? 1) + 1);
    }

    this.totalUpdates++;

    // Halve all α,β to forget stale observations (sliding window effect)
    // This prevents the system from being locked into past observations
    if (this.totalUpdates % this.discountInterval === 0) {
      this.discount();
    }
  }

  beliefs(queryClass: string): Array<{ source: string; expectedReward: number; confidence: number }> {
    const aMap = this.alphas.get(queryClass);
    const bMap = this.betas.get(queryClass);
    if (!aMap || !bMap) return [];

    const result: Array<{ source: string; expectedReward: number; confidence: number }> = [];
    for (const [source, alpha] of aMap) {
      const beta = bMap.get(source) ?? 1;
      // E[Beta(α,β)] = α / (α + β)
      result.push({
        source,
        expectedReward: alpha / (alpha + beta),
        confidence: alpha + beta - 2, // total observations (prior subtracted)
      });
    }
    return result.sort((a, b) => b.expectedReward - a.expectedReward);
  }

  // Floor=1 prevented alpha/beta from shrinking below prior, defeating the purpose
  private discount(): void {
    for (const [, aMap] of this.alphas) {
      for (const [source, val] of aMap) {
        aMap.set(source, Math.max(0.5, val * 0.5));
      }
    }
    for (const [, bMap] of this.betas) {
      for (const [source, val] of bMap) {
        bMap.set(source, Math.max(0.5, val * 0.5));
      }
    }
  }
}

// Produces samples from Beta(α,β) for Thompson Sampling decisions
// For production: consider replacing with a tested stats library
function betaSample(alpha: number, beta: number): number {
  const ga = gammaSample(alpha);
  const gb = gammaSample(beta);
  const denom = ga + gb;
  if (denom < 1e-15) return 0.5; // Uniform fallback
  return ga / denom;
}

// Reference: "A Simple Method for Generating Gamma Variables" (2000)
function gammaSample(shape: number): number {
  if (shape < 1) {
    // Boost: Gamma(a) = Gamma(a+1) * U^(1/a) for a < 1
    return gammaSample(shape + 1) * Math.pow(Math.random(), 1 / shape);
  }

  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);

  for (;;) {
    let x: number;
    let v: number;

    // Generate normal variate via Box-Muller
    do {
      x = normalSample();
      v = 1 + c * x;
    } while (v <= 0);

    v = v * v * v;
    const u = Math.random();

    // Squeeze test
    if (u < 1 - 0.0331 * (x * x) * (x * x)) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

function normalSample(): number {
  const u1 = Math.random();
  const u2 = Math.random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}
