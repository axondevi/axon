# Examples

Minimal, working code snippets for every Axon SDK. Each one runs in under a minute.

| File | Stack | Run |
|------|-------|-----|
| `ts-minimal.ts` | TypeScript · `@axon/client` | `AXON_KEY=ax_live_... bun ts-minimal.ts` |
| `python-minimal.py` | Python 3.9+ · `axon-client` | `AXON_KEY=ax_live_... python python-minimal.py` |
| `go-minimal.go` | Go 1.22+ · `axon-go` | `AXON_KEY=ax_live_... go run go-minimal.go` |
| `curl-minimal.sh` | curl, no SDK | `AXON_KEY=... bash curl-minimal.sh` |
| `mcp-claude-desktop-config.json` | MCP config for Claude Desktop | See [MCP docs](../mcp-server/README.md) |
| `langchain-ts.ts` | Vercel AI SDK + LangChain-compatible wiring | `AXON_KEY=... OPENAI_API_KEY=... bun langchain-ts.ts` |

All examples exercise three things:
1. Make an API call
2. Read the cost back from response metadata
3. Check wallet balance

If any of those breaks, you can file an issue with the exact example name.
