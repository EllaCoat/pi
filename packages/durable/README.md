# @earendil-works/pi-durable

Durable conversation, task, and document runtime for Pi.

This package contains the Pico runtime. Its current public API provides durable record contracts and memory, JSONL, and SQLite storage implementations:

```ts
import { MemoryStorage, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
```

The root export is runtime-neutral. Storage implementations also have explicit subpaths:

```ts
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
```

Node applications can open file-backed JSONL or SQLite storage through Node-only subpaths:

```ts
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

const jsonl = await openNodeJsonlStorage("./session", BACKGROUND_CONTEXT);
const sqlite = await openNodeSqliteStorage("./session.sqlite");
```

The portable JSONL core accepts the `FileSystem` capability exported from `@earendil-works/pi-durable/env`. Its `fsync` option defaults to `false`; enabling it flushes affected sidecars before appending the main commit marker. One `JsonlStorage` owner must serialize writes to a storage directory; cross-process locking and ID allocation are not supported.

The portable SQLite core, minimal database facade, and ordered schema migrations are exported from `@earendil-works/pi-durable/storage/sqlite`. Adapters for synchronous SQLite environments such as Bun and Cloudflare Durable Objects can implement that facade without importing Node APIs. Remote asynchronous APIs such as Cloudflare D1 cannot implement this synchronous facade; they require a dedicated `Storage` backend.

The Node adapter uses WAL mode with `synchronous = NORMAL` and checkpoints the WAL on close. Acknowledged commits survive process crashes, but the newest commits may be lost after a power or host failure. One `SqliteStorage` owner must serialize writes to a database file; cross-process ID allocation is not supported.

## Storage conformance

Storage adapters can register the runner-independent conformance cases through the testing entry. The convenience adapter accepts Vitest/Jest-compatible runner functions without importing either package:

```ts
import { registerStorageConformance } from "@earendil-works/pi-durable/testing";
import { describe, expect, it } from "vitest";

registerStorageConformance({ describe, expect, it }, "Some Custom Storage", async (use) => {
	const storage = await openCustomStorage();
	try {
		await use(storage);
	} finally {
		await closeStorage(storage);
	}
});
```

The provider must call and await `use` exactly once with isolated storage. Other runners can use `createStorageConformance` with their own `StorageConformanceAssertions` implementation.

## Storage workload definitions

`@earendil-works/pi-durable/testing` still exports synthetic workload seeds for independent adapter tests. This repository no longer ships a first-party storage benchmark runner; timed measurements are not part of the R1–R10 acceptance checks.

The normative design and implementation sequence are in:

- [`docs/pico-v5.md`](docs/pico-v5.md)
- [`docs/pico-v5-handoff.md`](docs/pico-v5-handoff.md)
- [`docs/pico-v5-chord-usage.md`](docs/pico-v5-chord-usage.md)
