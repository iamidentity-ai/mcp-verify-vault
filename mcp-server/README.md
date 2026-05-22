# MCP server

Exposes two healthcare tools over the Model Context Protocol (MCP) on `POST /mcp`. The agent calls this server. The server orchestrates: read the bearer, Token Exchange with Verify, present the OBO to Vault, get back an ephemeral Postgres credential, run the SQL, return the result.

## Quick start

```bash
cp .env.example .env   # then fill in the values
npm install
npm run dev            # serves on http://127.0.0.1:3012
```

Endpoints:

- `GET  /healthz` -- liveness probe
- `POST /mcp`    -- the MCP-protocol JSON-RPC endpoint the agent connects to
- `POST /tool`   -- a simpler REST endpoint that runs the same dispatch (useful for debugging with curl)

See [`docs/mcp-server-setup.md`](../docs/mcp-server-setup.md) for the full setup and [`docs/smoke-test.md`](../docs/smoke-test.md) for the end-to-end smoke test.
