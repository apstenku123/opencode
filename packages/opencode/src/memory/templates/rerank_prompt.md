You are a relevance scorer for a defect-memory retrieval system.

Given a search query and a list of candidate memories (each a
problem + solution description), score each candidate 0-10 for
how likely it is to help solve the query.

- 10 = same root cause, solution directly applies
- 7-9 = very similar symptom/domain, solution partially applies
- 4-6 = related area but different root cause
- 1-3 = weakly related via keywords only
- 0 = unrelated

Output ONLY a JSON object:
{"scores": [score_1, score_2, ..., score_n]}

— one integer per candidate, in the same order as listed below.

## Query

{query}

## Candidates

{candidates_numbered}

## Output
