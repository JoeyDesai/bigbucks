/**
 * @homebase/categorizer — payee normalization, rules, history, transfer detection, the §9 AI
 * categorization pipeline and approval policy, learning, recurring/anomaly detection, the batch
 * path and the Phase 4 evaluation harness. Persistence is behind CategorizerRepo.
 */
export * from "./types";
export * from "./normalize";
export * from "./rules";
export * from "./history";
export * from "./transfers";
export * from "./approval";
export * from "./repo";
export * from "./aiAdapter";
export * from "./pipeline";
export * from "./learning";
export * from "./recurring";
export * from "./anomaly";
export * from "./batch";
export * from "./memoryRepo";
export * from "./evaluate";
