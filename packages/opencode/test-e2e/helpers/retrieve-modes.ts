// Helper invoked by the Python e2e test for `memories.retrieval.mode`.
// Seeds three sextuples and retrieves the same query under each of the
// three supported modes (cosine / bm25 / hybrid), then prints the
// resulting orderings as JSON so the test can assert they diverge.
//
// Runs via `bun run --conditions=browser helpers/retrieve-modes.ts ...`
// with CWD inside the opencode package so node_modules/effect resolves
// to the workspace-local effect@4.x rather than bun's global cache.

import { Effect } from "effect"
import { Memory, defaultLayer } from "../../src/memory"

process.env.XDG_DATA_HOME = process.argv[2]
process.env.XDG_CACHE_HOME = process.argv[3]
process.env.XDG_CONFIG_HOME = process.argv[4]
process.env.XDG_STATE_HOME = process.argv[5]

const fixtures = [
  {
    keywords: ["react", "infinite", "loop", "setstate"],
    problem:
      "React component renders an infinite loop when setState is called inside useEffect without a dep array",
    rootCause:
      "useEffect with no dependency array re-runs on every render; calling setState triggers a re-render",
    solution:
      "Provide an explicit dependency array or move setState to an event handler",
    source: {
      _tag: "rollout" as const,
      threadID: "t1",
      timestamp: Date.now(),
    },
  },
  {
    keywords: ["sql", "injection", "prepared", "statement"],
    problem:
      "SQL injection vulnerability via string interpolation in user-id query",
    rootCause:
      "Raw string concatenation let attackers inject DROP TABLE payloads",
    solution:
      "Use parameterised queries / prepared statements for every user-supplied input",
    source: {
      _tag: "rollout" as const,
      threadID: "t2",
      timestamp: Date.now(),
    },
  },
  {
    keywords: ["goroutine", "race", "condition", "mutex"],
    problem:
      "Goroutine race condition on the shared counter in the writer path",
    rootCause:
      "Two goroutines increment the same integer without synchronisation",
    solution:
      "Guard the counter with a sync.Mutex or use atomic.AddInt64",
    source: {
      _tag: "rollout" as const,
      threadID: "t3",
      timestamp: Date.now(),
    },
  },
]

const query = "infinite re-render loop in React setState"

const seed = Effect.gen(function* () {
  const memory = yield* Memory
  for (const sx of fixtures) {
    yield* memory.add(sx)
  }
})

const retrieve = (mode: "cosine" | "bm25" | "hybrid") =>
  Effect.gen(function* () {
    const memory = yield* Memory
    const hits = yield* memory.retrieve({
      queryText: query,
      topK: 3,
      minScore: 0,
      mode,
    })
    return hits.map((h) => ({
      hashId: h.record.hashId,
      problem: h.record.problem,
      score: h.score,
      bm25Score: h.bm25Score,
    }))
  })

const program = Effect.gen(function* () {
  yield* seed
  const cosine = yield* retrieve("cosine")
  const bm25 = yield* retrieve("bm25")
  const hybrid = yield* retrieve("hybrid")
  return { cosine, bm25, hybrid }
})

const out = await Effect.runPromise(
  program.pipe(Effect.provide(defaultLayer)),
)
process.stdout.write(JSON.stringify(out, null, 2) + "\n")
