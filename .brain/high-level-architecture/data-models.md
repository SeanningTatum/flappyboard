# Data Models

## Schema location

**Source of truth:** [`app/db/schema.ts`](../../app/db/schema.ts). Always read it directly for current column lists.

## Tables

| Table | Purpose | Key relations |
|-------|---------|---------------|
| `user` | Core user with role + ban fields | Referenced by `session.userId`, `account.userId` |
| `session` | Active sessions (Better Auth) | `userId → user.id` (cascade), `impersonatedBy` (admin user id, no FK) |
| `account` | Credential / OAuth accounts | `userId → user.id` (cascade) |
| `verification` | Email verification tokens | Linked logically by `identifier` (email) |
| `board` | One split-flap board: owner, name, `soundPack`, `muted`, `revision`, `grantEpoch` | `ownerId → user.id` (cascade) |
| `board_snapshot` | Immutable history — one row per applied write | `boardId → board.id` (cascade); unique `(board_id, revision)` |

The first four tables are owned by Better Auth's drizzle adapter. `board` / `board_snapshot` are the first app-owned business tables (feature `split-flap-board`, phase 2).

### Board tables — what to know before touching them

- **`board.revision` is a cache, not the source of truth.** The authoritative live revision lives in the `BoardRoom` Durable Object; the column exists so a cold read (or a future automation) can tell how far a board has advanced without waking the room. It is bumped **monotonically** (`WHERE revision < :new`) in both `BoardRepository.saveSnapshot` and the DO's own persist path, so a late-arriving older write can never move it backwards.
- **`board.grantEpoch` is the pairing revocation counter.** It is inside the signed message of every pairing token and controller grant for that board (`app/lib/board/pairing.ts`), so `board.revokeControllers` incrementing it invalidates all of them at once — for that board only. It lives on the row rather than in the Durable Object precisely so the request worker can check it off a read `requireBoardAccess` already does; moving it into DO storage would put a DO call on every authorised request. Incremented in SQL (`grant_epoch = grant_epoch + 1`), never read-modify-write, so concurrent revokes both count and the counter is monotonic.
- **`board_snapshot.cells` is untrusted on read.** It's a `JSON.stringify(BoardGrid)` blob that may have been written by an older or newer deploy, so parse *and* re-validate the 6×24 invariant — `parseSnapshotCells` in `app/repositories/board.ts` returns `null` rather than throwing.
- **`source` accepts `manual | llm | automation`.** Nothing writes `automation` yet; it exists so the deferred paid automations feature needs no migration. The wire protocol accepts all three deliberately — narrowing it would silently relabel an automation write as `manual`.
- The unique `(board_id, revision)` index turns a duplicate revision into a `CreationError` instead of silently corrupting history.

## Entity relationships

```
user ◄─────┬───── session   (userId, impersonatedBy)
           │
           ├───── account   (userId)
           │
           └─ ─ ─ verification (by identifier=email, no FK)
```

## SQLite / Drizzle conventions

- **Booleans**: `integer("col", { mode: "boolean" })` (stored as 0/1)
- **Timestamps**: `integer("col", { mode: "timestamp_ms" })` — Date ↔ ms-since-epoch. Default via `sql\`(cast(unixepoch('subsecond') * 1000 as integer))\`` for `createdAt` / `updatedAt`. `$onUpdate(() => new Date())` for `updatedAt`.
- **Enums**: `text("col", { enum: [...] })` — e.g. `user.role: "user" | "admin"`
- **JSON**: `text("col", { mode: "json" }).$type<T>()`
- **Foreign keys**: `references(() => parent.id, { onDelete: "cascade" })`. Always specify `onDelete`.
- **SQL identifiers**: `snake_case`. **TypeScript variables**: `camelCase`.

## Inferred types

```typescript
export type User = typeof user.$inferSelect;
export type UpdateUserInput = typeof user.$inferInsert;
```

Repository input types use Effect Schema in `app/lib/schemas/{domain}.ts` — those are the **canonical** input shapes for procedures and repos. Inferred Drizzle types are for raw row shape only.

## Migrations

- **Location**: `drizzle/`
- **Generate**: `bun run db:generate`
- **Apply locally**: `bun run db:migrate:local` (auto-runs on `bun run dev`)
- **Apply remote**: `bun run db:migrate:remote`
- **Studio**: `bun run db:studio`

See [`../rules/repository.md`](../rules/repository.md) for the full Drizzle pattern.
