import { Layer, ManagedRuntime } from "effect";
import { CloudflareEnvLive } from "@/services/cloudflare";
import { DatabaseLive, type Database } from "@/services/database";
import { AuthApiLive, type AuthApi as AuthApiTag } from "@/services/auth";
import { WorkflowsLive, type Workflows } from "@/services/workflows";
import { BoardRoomLive, type BoardRoom } from "@/services/board-room";
import { BoardAgentLive, type BoardAgent } from "@/services/board-agent";
import { LoggerLive, MinLogLevelLive } from "@/services/logger";
import { UserRepository } from "@/repositories/user";
import { AnalyticsRepository } from "@/repositories/analytics";
import { BoardRepository } from "@/repositories/board";

export type AppServices =
  | Database
  | AuthApiTag
  | Workflows
  | BoardRoom
  | BoardAgent
  | UserRepository
  | AnalyticsRepository
  | BoardRepository;

// `baseURL` is the request's own origin — threaded through to Better Auth
// via `AuthApiLive(baseURL)` so the single construction path (Effect.try →
// ExternalServiceError, unit-tested in services/__tests__/auth.test.ts) is
// used in production too. No more raw `createAuth(...)` call outside Effect.
export const makeAppRuntime = (env: Env, baseURL?: string) => {
  // Every member of a merged layer is constructed when the runtime is built, so
  // one service with a missing binding fails ALL of them — a missing R2 binding
  // was surfacing as "Failed to construct AuthApi" and 500ing every request.
  // R2 is therefore not part of the global runtime: `BucketLive` +
  // `BucketRepository` are provided ad-hoc by the one route that needs them
  // (`routes/api/board-ws.ts`'s sibling, `routes/api/upload-file.ts`), the same
  // way `SessionLive` is — see `.brain/rules/services.md`. A binding that is
  // absent now breaks only the feature that uses it.
  // BoardAgentLive is safe to merge here even though ANTHROPIC_API_KEY is a
  // secret rather than a declared binding: it never fails construction on a
  // missing key, it returns a shape whose `generate` fails with a typed
  // ConfigurationError. See the comment on `unconfiguredBoardAgent`.
  const baseLayer = Layer.mergeAll(
    DatabaseLive,
    AuthApiLive(baseURL),
    WorkflowsLive,
    BoardRoomLive,
    BoardAgentLive
  );
  const reposLayer = Layer.mergeAll(
    UserRepository.Default,
    AnalyticsRepository.Default,
    BoardRepository.Default
  );
  const layer = reposLayer
    .pipe(Layer.provideMerge(baseLayer))
    .pipe(Layer.provide(CloudflareEnvLive(env)))
    .pipe(Layer.provideMerge(Layer.merge(LoggerLive, MinLogLevelLive)));
  return ManagedRuntime.make(layer);
};

export type AppRuntime = ReturnType<typeof makeAppRuntime>;
