---
name: mcp-code-search
description: "Use the MCP grep server (`grep_searchGitHub`) for code search and GitHub code lookups instead of `web_search` or `code_search`. The `code_search` tool triggers an SSH passphrase prompt which blocks the workflow. The MCP grep tool searches literal code patterns across millions of public GitHub repos. Use whenever the user asks to find code examples, search GitHub repos, look up API usage patterns, or understand how libraries are used in real projects."
---

# MCP Code Search

## IMPORTANT: Tool Preference

When the user asks you to search for code, find GitHub examples, look up API usage patterns, or research how libraries are used in the wild:

1. **Always prefer** the `mcp` tool with `grep_searchGitHub` over `web_search` or `code_search`
2. **Only fall back** to `web_search` if the MCP grep server returns a 500 error or is unavailable
3. **Never use** the built-in `code_search` tool — it triggers an SSH passphrase prompt and blocks the workflow

## How to Use the MCP Grep Tool

The `grep_searchGitHub` tool searches for **literal code patterns** (like grep), not keywords. Search for actual code that would appear in files.

### Basic Usage

```
mcp({
  tool: "grep_searchGitHub",
  args: {
    query: "literal code pattern to search",
    language: ["TypeScript"],
  }
})
```

### Search Examples

| Goal | Query | Notes |
|------|-------|-------|
| Find React imports | `"import React from"` | Literal string |
| Find async functions | `"async function"` | Literal string |
| Find useState patterns | `"useState("` | Literal string |
| Find multi-line patterns | `"(?s)try {.*await"` | Use `useRegexp: true` |
| Find specific repo patterns | `"createAgentSession"` | Use `repo: "earendil-works/pi"` |

### Filter Parameters

- `query` (string, required) — The literal code pattern to search for
- `repo` (string) — Filter by repository, e.g. `"facebook/react"`, `"vercel/"`, `"microsoft/"`
- `path` (string) — Filter by file path, e.g. `"src/components/Button.tsx"`, `"/route.ts"`
- `language` (array) — Filter by language, e.g. `["TypeScript", "TSX"]`, `["Python"]`, `["Rust"]`
- `matchCase` (boolean) — Case-sensitive search (default: false)
- `matchWholeWords` (boolean) — Whole word matching (default: false)
- `useRegexp` (boolean) — Interpret query as regex (default: false). Prefix with `(?s)` for multi-line matching

### Good vs Bad Queries

✅ **Good** (literal code that appears in files):
- `"useState("`
- `"import React from"`
- `"async function"`
- `"export default function"`
- `"(?s)try {.*await"` (with `useRegexp: true`)

❌ **Bad** (keywords, not code):
- `"react tutorial"`
- `"best practices"`
- `"how to use"`
- `"authentication in Next.js"`

### Fallback

If `grep_searchGitHub` returns an error (500, timeout, etc.), use `web_search` as a fallback to find what the user needs. Never use `code_search`.
