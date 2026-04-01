export { extractSymbols, detectLanguage, computeAstFingerprint } from "./symbol-extractor.js";
export type { ExtractedSymbol, ExtractionResult } from "./symbol-extractor.js";
export {
  buildCallGraph, buildAdjacency, reachableFrom, tracePath, detectArchitecture,
} from "./call-graph.js";
export type {
  CallGraphSymbol, CallEdge, ModuleInfo, ArchitectureMap,
} from "./call-graph.js";
export { compressToSignatures } from "./signature-compress.js";
