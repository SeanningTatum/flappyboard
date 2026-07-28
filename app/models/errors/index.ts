export * from "./repository";
export * from "./bucket";
export * from "./workflow";
export * from "./board";

import type { RepositoryError } from "./repository";
import type { BucketError } from "./bucket";
import type { WorkflowError } from "./workflow";
import type { BoardError } from "./board";

export type AppError = RepositoryError | BucketError | WorkflowError | BoardError;
