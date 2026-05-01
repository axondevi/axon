# @axon/mcp-server

MCP (Model Context Protocol) server that exposes the [Axon](https://axon.dev) API catalog as tools for any MCP client — **Claude Desktop**, **Claude Code**, **Cursor**, **Zed**, and more.

Your agent gets one-wallet access to every paid API in the Axon catalog, charged per request in USDC.

## Install

```bash
npm install -g @axon/mcp-server
# or: npx @axon/mcp-server
```

## Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "axon": {
      "command": "npx",
      "args": ["-y", "@axon/mcp-server"],
      "env": {
        "AXON_KEY": "ax_live_..."
      }
    }
  }
}
```

Restart Claude Desktop. In a new chat you'll see all Axon catalog APIs as available tools. Ask Claude to "search the web for today's top news" and it'll pick `serpapi__search` automatically.

## Claude Code

```bash
claude mcp add axon -- npx -y @axon/mcp-server
```

Set `AXON_KEY` in your environment or via the `env` option in the config file.

## Cursor / Zed / others

Any MCP-compatible client that speaks stdio transport works. Point it at `npx @axon/mcp-server` with `AXON_KEY` in env.

## Environment variables

| Var | Required | Default | Purpose |
|-----|----------|---------|---------|
| `AXON_KEY` | yes | — | Your Axon API key |
| `AXON_BASE_URL` | no | `https://axon-kedb.onrender.com` | Override for self-hosted |
| `AXON_APIS` | no | all | Comma-separated slugs to expose (e.g. `serpapi,firecrawl,exa`) |

## What's exposed

- **Every API in your Axon catalog** — each endpoint becomes an MCP tool named `{slug}__{endpoint}` (e.g. `serpapi__search`)
- **Built-ins**: `axon__balance`, `axon__catalog`

## Cost per call

Every response from a tool includes the USDC amount charged and whether it hit cache. Your agent sees its own spending as it works.

## License

MIT
