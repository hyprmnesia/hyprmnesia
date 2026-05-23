---
"hyprmnesia": minor
---

Add local semantic search over captures. A new `hpm-embed` worker computes
sentence embeddings for OCR text and transcript segments locally, stored via the
`sqlite-vec` extension alongside the FTS5 index. The MCP `search` tool gains a
`mode` argument (`lexical`, `semantic`, `hybrid`); hybrid is the default and
fuses BM25 with vector similarity via Reciprocal Rank Fusion, falling back to
FTS5 when the embedding index is unavailable. Configurable under
`processing.embeddings`.
