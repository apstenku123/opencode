// Helper invoked by the Python e2e test for the `<similar_past_problems>`
// injection path. Seeds one defect sextuple, then asks the Memory facade
// to build a prompt-enrichment block for a related user query and prints
// the result as JSON.

import { Effect } from "effect"
import { Memory, defaultLayer } from "../../src/memory"

process.env.XDG_DATA_HOME = process.argv[2]
process.env.XDG_CACHE_HOME = process.argv[3]
process.env.XDG_CONFIG_HOME = process.argv[4]
process.env.XDG_STATE_HOME = process.argv[5]

const program = Effect.gen(function* () {
  const memory = yield* Memory
  yield* memory.add({
    keywords: ["react", "infinite", "loop", "useeffect"],
    problem:
      "React app hit Maximum update depth exceeded because useEffect with an empty dep array set state unconditionally",
    rootCause:
      "setState call inside useEffect without the right dependency array caused a re-render loop",
    solution:
      "Move the setState into an event handler or add a proper dependency array",
    source: {
      _tag: "rollout" as const,
      threadID: "t-prior",
      timestamp: Date.now(),
    },
  })
  const result = yield* memory.enrichPrompt({
    userPrompt:
      "My React component keeps re-rendering in a loop after calling setState inside useEffect. What should I do?",
    topK: 3,
    minScore: 0,
  })
  return result
})

const out = await Effect.runPromise(
  program.pipe(Effect.provide(defaultLayer)),
)
process.stdout.write(JSON.stringify(out, null, 2) + "\n")
