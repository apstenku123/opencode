---
name: bm25-kb-search
description: BM25-based knowledge base search for session context and RAG
version: 1
tags: [bm25, knowledge-base, rag, search, tokenize, idf, session, pattern]
execution_mode: knowledge
dependencies: []
---

# BM25 Knowledge Base Search

## When to use
When working with the RAG context system, knowledge base indexing, or the
`kb_search` tool that provides LLM access to session history.

## Reference files
- `codex-rs/session-recorder/src/knowledge_base.rs` — core KB + BM25
- `codex-rs/core/src/tools/handlers/search_tool_bm25.rs` — kb_search tool
- `codex-rs/core/src/skills/schema.rs` — skill BM25 index (same tokenizer)

## Architecture

### Data flow
```
Session events → extract → KnowledgeBaseBuilder → KbIndex → kb_search tool
```

1. **Session events** are recorded during agent execution.
2. **KnowledgeBaseBuilder** processes events into documents with MD tree
   directory structure.
3. Documents are tokenized and indexed into a `KbIndex`.
4. The `kb_search` tool queries the index at runtime.

### KnowledgeBaseBuilder
```rust
use codex_session_recorder::KnowledgeBaseBuilder;

let builder = KnowledgeBaseBuilder::new(kb_config);
// ... feed session events ...
// builder produces a KbIndex for searching
```

### KbIndex structure
- `entries: Vec<KbIndexEntry>` — each entry has:
  - `name`, `description`
  - `token_count` — number of tokens in the document
  - `term_freqs: HashMap<String, u32>` — term frequency map
- `avg_doc_length: f64` — average document length across all entries

## BM25 scoring

### Parameters
- **k1 = 1.2** — term frequency saturation. Higher values give more weight to
  repeated terms.
- **b = 0.75** — length normalization. 1.0 = full normalization, 0.0 = none.

### Formula
For each query term t in document d:
```
score(t, d) = IDF(t) * (tf(t,d) * (k1 + 1)) / (tf(t,d) + k1 * (1 - b + b * |d| / avgdl))
```

Where:
- `tf(t,d)` = term frequency of t in document d
- `|d|` = document length in tokens
- `avgdl` = average document length
- `IDF(t)` = inverse document frequency

### IDF calculation
```
IDF(t) = ln((N - n(t) + 0.5) / (n(t) + 0.5) + 1)
```
Where N = total documents, n(t) = documents containing term t.

## Tokenizer
```rust
pub fn tokenize(text: &str) -> Vec<String> {
    text.to_lowercase()
        .split(|c: char| !c.is_alphanumeric() && c != '_')
        .filter(|s| s.len() >= 2)
        .map(String::from)
        .collect()
}
```

Key characteristics:
- Lowercased
- Splits on non-alphanumeric (except underscore `_`)
- Minimum token length: 2 characters
- Underscores are preserved (important for Rust identifiers like `some_function`)
- Same tokenizer is used in both `knowledge_base.rs` and `skills/schema.rs`

## PatternDetector
Extracts recurring patterns and insights from session events:
- Error patterns (repeated compilation errors)
- Tool usage patterns
- File access patterns
These become additional documents in the knowledge base for retrieval.

## kb_search tool
Registered as `KB_SEARCH_TOOL_NAME = "kb_search"`.
- Enabled when `rag_context_enabled` is set in config
- Takes a query string, tokenizes it, runs BM25 against the index
- Returns ranked results with scores
- Minimum score threshold configurable via CLI (`--rag-min-score`, default 0.5)

## Skill index (same approach)
Skills are also BM25-indexed via `Skill::to_index_entry()`:
- Combines name, description, content, tags, dependencies into a text blob
- Tokenizes with the same `tokenize()` function
- Stored in `SkillIndex` for retrieval when the agent needs a skill

## Key rules
- The tokenizer is shared between knowledge base and skills — changes to one
  affect the other
- BM25 uses exact token matching, not fuzzy. "connection_refused" matches
  "connection_refused" but not "connection refused" (two separate tokens)
- File lock (RAII) + stale PID recovery protects concurrent KB access
