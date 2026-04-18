/**
 * Zod schemas for the GitHub Copilot BlackBird API.
 *
 * BlackBird is GitHub Copilot's internal code-intelligence service used for
 * semantic code search and RAG (retrieval-augmented generation). The
 * endpoints live on `api.github.com` but use a distinct
 * `X-GitHub-Api-Version: 2025-05-01` header (the chat/completions API
 * uses `2026-01-09`).
 *
 * Mirrors the Rust reference `codex-rs/github-copilot/src/blackbird.rs`.
 */

import { z } from "zod"

// ── Request schemas ──────────────────────────────────────────────────────

export const ChunkDocumentSchema = z.object({
  path: z.string(),
  content: z.string(),
})
export type ChunkDocument = z.infer<typeof ChunkDocumentSchema>

export const ChunksRequestSchema = z.object({
  documents: z.array(ChunkDocumentSchema),
})
export type ChunksRequest = z.infer<typeof ChunksRequestSchema>

export const EmbeddingsRequestSchema = z.object({
  inputs: z.array(z.string()),
  model: z.string().optional(),
})
export type EmbeddingsRequest = z.infer<typeof EmbeddingsRequestSchema>

export const CodeSearchRequestSchema = z.object({
  prompt: z.string(),
  scoping_query: z.string(),
  include_embeddings: z.boolean().optional(),
  limit: z.number().int().positive().optional(),
})
export type CodeSearchRequest = z.infer<typeof CodeSearchRequestSchema>

// ── Response schemas ─────────────────────────────────────────────────────

export const LineRangeSchema = z.object({
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
})
export type LineRange = z.infer<typeof LineRangeSchema>

export const ChunkSchema = z.object({
  text: z.string(),
  path: z.string().optional(),
  line_range: LineRangeSchema.optional(),
})
export type Chunk = z.infer<typeof ChunkSchema>

export const ChunksResponseSchema = z.object({
  chunks: z.array(ChunkSchema),
})
export type ChunksResponse = z.infer<typeof ChunksResponseSchema>

export const EmbeddingResultSchema = z.object({
  embedding: z.array(z.number()),
})
export type EmbeddingResult = z.infer<typeof EmbeddingResultSchema>

export const EmbeddingsResponseSchema = z.object({
  embeddings: z.array(EmbeddingResultSchema),
})
export type EmbeddingsResponse = z.infer<typeof EmbeddingsResponseSchema>

export const CodeLocationSchema = z.object({
  path: z.string(),
})
export type CodeLocation = z.infer<typeof CodeLocationSchema>

export const SearchChunkSchema = z.object({
  text: z.string(),
  line_range: LineRangeSchema.optional(),
})
export type SearchChunk = z.infer<typeof SearchChunkSchema>

export const CodeSearchResultSchema = z.object({
  location: CodeLocationSchema,
  chunk: SearchChunkSchema,
})
export type CodeSearchResult = z.infer<typeof CodeSearchResultSchema>

export const CodeSearchResponseSchema = z.object({
  results: z.array(CodeSearchResultSchema),
  embedding_model: z.string().optional(),
})
export type CodeSearchResponse = z.infer<typeof CodeSearchResponseSchema>

export const EmbeddingsIndexResponseSchema = z.object({
  semantic_code_search_ok: z.boolean().default(false),
})
export type EmbeddingsIndexResponse = z.infer<typeof EmbeddingsIndexResponseSchema>
