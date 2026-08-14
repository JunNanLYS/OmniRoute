/**
 * Distillation worker — barrel.
 *
 * The module surface exposed to:
 *   - instrumentation-node.ts (startDistillationWorker / stopDistillationWorker)
 *   - gracefulShutdown.ts (stopDistillationWorker)
 *   - any future /api/memory/distillation/* route (the InMemoryDistillationStore
 *     and InMemoryDistillationStore factory for tests)
 *   - integration tests under tests/unit/memory/distillation/
 */

export {
  resolveDistillationConfig,
  isWorkerStartAllowed,
  parseDistillationModelOverride,
  DEFAULT_DISTILLATION_INTERVAL_SECONDS,
  DEFAULT_DISTILLATION_CONCURRENCY,
  DEFAULT_DISTILLATION_MAX_DEPTH,
  DEFAULT_DISTILLATION_MAX_CALLS,
  DEFAULT_DISTILLATION_MAX_STEPS,
  DEFAULT_DISTILLATION_MAX_TOKENS,
  type DistillationEnvConfig,
} from "./config.ts";

export {
  InMemoryDistillationStore,
  createDefaultDistillationStore,
  makeStoreUnavailable,
  type DistillationStore,
  type DistillationTask,
  type DistillationTaskKind,
  type DistillationTaskStatus,
  type DistillationUsageRecord,
  type DistillationDLQEntry,
  type DistillationLock,
  type ClaimResult,
} from "./store.ts";

export {
  ProcessPermitPool,
  releasePermit,
  type AcquiredPermit,
  type PermitPoolOptions,
} from "./permit.ts";

export {
  WARMUP_RAMP_MS,
  IDLE_BACKOFF_MS,
  L2_INITIAL_DELAY_MS,
  L2_MIN_DEBOUNCE_MS,
  L2_MAX_DEBOUNCE_MS,
  L3_IMMEDIATE_DELAY_MS,
  RETRY_BACKOFF_MS,
  MAX_RETRY_ATTEMPTS,
  nextWarmupDelayMs,
  isAtWarmupRamp,
  computeRetryBackoffMs,
  clampRetryAttempt,
  initialDelayForKind,
  nextSceneScheduleMs,
  shouldDeferScene,
  idleSleepMs,
} from "./scheduler.ts";

export {
  resolveDistillationSelection,
  validateModelStillUsable,
  type SelectorDeps,
  type SelectorResolution,
  type PerKeyDistillationSettings,
  type GlobalDistillationSettings,
  type CatalogSnapshot,
} from "./selector.ts";

export {
  classifyFailure,
  decideRetry,
  sanitizeMessage,
  extractStatusCode,
  isNetworkError,
  MAX_STORED_ERROR_LENGTH,
  type ClassifiedError,
  type FailureKind,
  type RetryDecision,
} from "./failure.ts";

export {
  signInternalMarker,
  verifyInternalMarker,
  verifyLoopbackOrigin,
  INTERNAL_MARKER_HEADER,
  INTERNAL_SIGNATURE_HEADER,
  INTERNAL_DEPTH_HEADER,
  INTERNAL_CALLS_HEADER,
  type InternalMarkerParts,
  type SignOptions,
  type VerifyOptions,
  type VerifyResult,
  type LoopbackOriginCheckOptions,
  type LoopbackVerdict,
} from "./internalMarker.ts";

export {
  withOwnerLock,
  isLockStillValid,
  LOCK_TTL_MS,
  LOCK_RENEW_MS,
  type OwnerLockHandle,
  type OwnerLockOptions,
  type IntervalScheduler,
} from "./lock.ts";

export {
  UsageBatcher,
  buildUsageRecord,
  type UsageBatcherOptions,
  type IntervalScheduler as UsageIntervalScheduler,
} from "./usage.ts";

export {
  executeDistillationTask,
  makeProductionBreakerHook,
  makeCodedError,
  type DistillationCredentials,
  type ExecutorBreakerHook,
  type ExecutorDeps,
  type ExecutorResult,
  type ExecutorRunOutcome,
} from "./executor.ts";

export {
  DEFAULT_HANDLERS,
  L0ChunkEmbedHandler,
  L1ExtractHandler,
  L2SceneHandler,
  L3PersonaHandler,
  clampPrompt,
  type DistillationHandler,
  type HandlerCallArgs,
  type HandlerOutcome,
  type HandlerResult,
  type HandlerError,
} from "./handlers.ts";

export {
  startDistillationWorker,
  stopDistillationWorker,
  tickOnce,
  buildInitialDelayForKind,
  __resetDistillationWorkerForTests,
  type StartDeps,
  type StopOptions,
  type WorkerRuntimeOptions,
} from "./worker.ts";
