export {
  computeFingerprint, jaccardSimilarity, clusterByJaccard,
  normalizeCode, contentHash,
} from "./winnowing.js";
export type { WinnowingFingerprint, FingerprintCluster } from "./winnowing.js";

export { computeScore, compositeScore, applyHardCaps, mmrDiversify, durabilityVitality } from "./quality-scorer.js";
export type { ScoredItem } from "./quality-scorer.js";
export type { RawSignals } from "./quality-scorer.js";

export {
  classifySymbol, groupByArchetype, archetypeName, archetypeTradeoffs,
} from "./archetype-classifier.js";
export type { ClassifiedSymbol } from "./archetype-classifier.js";

export { sacSimilarity, splitIdentifier, shapeSignature } from "./sac.js";

export { EarlyTerminator } from "./early-terminator.js";
export type { EarlyTerminatorConfig } from "./early-terminator.js";
