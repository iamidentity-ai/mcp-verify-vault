## Run the agent

The agent is a small Python + Strands process that runs as a FastAPI server. It receives a clinician's prompt over HTTP, forwards the clinician's IBM Verify access token to the MCP server as an `Authorization: Bearer` header, lets Strands decide which MCP tool to call, and streams the model's text response back over Server-Sent Events. The agent has no security responsibilities of its own; everything in the security chain (Token Exchange, RAR, step-up MFA, OBO mint, the Vault verify-rar plugin, the ephemeral PostgreSQL credential) happens inside the MCP server you started in the previous chapter.

The agent has no AWS dependency. The cookbook's default LLM is Anthropic direct (`claude-sonnet-4-5-20250929`). The full list of swappable LLMs is in the next chapter.

## Install Python deps

Move into the `agent/` directory and create a virtual environment. A venv keeps the agent's dependencies separate from anything else on your system.

```bash
cd agent
python3.11 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip
pip install -e .
```

Expected: `Successfully installed fastapi-... strands-agents-... mcp-... uvicorn-...` plus a few transitive dependencies. The base install brings `strands-agents[anthropic]` which handles the default `LLM_PROVIDER=anthropic` path; the other providers (`bedrock`, `openai`, `gemini`) are pip extras and live in the next chapter.

If `pip install -e .` fails on a missing extra you have not configured, leave `LLM_PROVIDER` at its default of `anthropic` and try again.

## Configure `.env`

Still inside `agent/`:

```bash
cp .env.example .env
```

Open `.env` and fill in the one value that has no default:

```bash
# Anthropic direct, from console.anthropic.com -> API keys
ANTHROPIC_API_KEY=sk-ant-...
```

The other defaults match the local stack the previous chapters brought up:

```bash
HEALTHCARE_MCP_URL=http://127.0.0.1:3012/mcp
LLM_PROVIDER=anthropic
```

If you want to point at a different MCP server (different port, different host, deployed somewhere), change `HEALTHCARE_MCP_URL`. If you want to use a non-default LLM, see [Swapping the LLM](./llm-options.md).

## Run locally

```bash
uvicorn healthcare_agent.main:app --host 127.0.0.1 --port 8080 --reload
```

Expected:

```
INFO:     Will watch for changes in these directories: ['.../agent']
INFO:     Uvicorn running on http://127.0.0.1:8080 (Press CTRL+C to quit)
INFO:     Started reloader process
INFO:     Started server process
INFO:     Waiting for application startup.
INFO:     Application startup complete.
```

Leave that terminal open. You will hit it from the smoke-test chapter in another terminal. A `--reload` argument means the server picks up code edits automatically; remove it for a quieter run.

A `GET /healthz` confirms the server is up. From a second terminal:

```bash
curl -s http://127.0.0.1:8080/healthz
```

Expected:

```json
{"status":"ok","service":"healthcare-agent"}
```

## The agent's two endpoints

The agent only has two routes. Both are intentional. Keep them small so the security-relevant behavior is obvious.

`GET /healthz` returns `{"status":"ok"}`. No authentication. It is for liveness checks.

`POST /invoke` is the actual agent turn. It takes:

- `Authorization: Bearer <clinician-access-token>` — the IBM Verify access token the clinician got from PKCE. The agent does not validate this token; it forwards it to the MCP server, which uses it as the RFC 8693 `subject_token`. If the token is missing, the agent returns `401 missing_bearer` immediately without doing any work.
- `Content-Type: application/json`
- A JSON body `{"prompt": "<the user's natural-language prompt>"}`

The response is `Content-Type: text/event-stream`. The agent yields the model's text output as SSE `data:` lines as Strands produces them, ending with `data: [DONE]`. The whole exchange typically takes 5-15 seconds for a non-VIP read (a few model turns to choose the tool, call it, and summarize the result), and 30 seconds or longer for a VIP read (because the MCP server is waiting for a clinician to approve a push on their phone, and the agent is just sitting on that long-running tool call). The smoke-test chapter exercises both.

## Why FastAPI and Strands

A note on framework choice for engineers reviewing the code. Two pieces.

`FastAPI` is the HTTP server. It is one of the most-used Python web frameworks (alongside Flask and Django), it speaks ASGI, and it ships first-class Server-Sent Events support via its `StreamingResponse` class. The `healthcare_agent/main.py` file is around 50 lines top-to-bottom and you can read it end-to-end in a minute.

`Strands` is the agent loop. It is the model-agnostic agent framework (Anthropic, OpenAI, Gemini, Bedrock-Anthropic all behind one interface) maintained by AWS, but the framework itself has no AWS dependency. It does three things you would otherwise write by hand: the tool-use while-loop (model says `tool_use`, you call the tool, you post the result back), the MCP-tool-to-Strands-tool adaptation (so the MCP server's tool definitions become Strands tool definitions automatically), and the streaming event model. About 100 lines of agent loop logic that you do not have to maintain.

If you want to drop Strands and roll your own loop against the Anthropic SDK directly, the same `/invoke` endpoint shape and the same MCP wire protocol still work. Strands is the cookbook's choice for readability, not a hard requirement.

## Hosting

This chapter ran the agent on your laptop. That is plenty for the cookbook's purpose: prove the chain works end-to-end with a real clinician token. When you are ready to put the agent somewhere your calling app can reach over the network, any host that runs Python and exposes an HTTP port will do. Three sensible defaults:

- **Container, on anything.** Build a tiny Dockerfile (`FROM python:3.11-slim`, `pip install -e .`, `CMD ["uvicorn", "healthcare_agent.main:app", "--host", "0.0.0.0", "--port", "8080"]`) and ship it to your container platform of choice (a customer's EKS / GKE / OpenShift / Fly / Render).
- **A small VM.** `apt install python3.11 python3.11-venv`, clone the repo, run uvicorn under systemd. The cookbook's resource footprint is tiny.
- **A laptop, for evaluation.** What you are doing right now.

There is no "preferred" deployment in this cookbook because the security model does not depend on it. The same Verify Token Exchange + Vault verify-rar chain runs regardless of where the agent process lives. The hosting decision is your customer's.

## What you just did

You installed the agent's Python dependencies in a virtual environment, configured the LLM provider (Anthropic direct by default), and started the agent on `127.0.0.1:8080`. The agent is ready to forward the next clinician token to the MCP server.

## What you'll do next

Move on to [End-to-end smoke test](./smoke-test.md) to mint a clinician token via OIDC + PKCE, hit `/invoke` with a real prompt, and watch the chain (Verify Token Exchange → Vault verify-rar → ephemeral PostgreSQL → SELECT → return) execute end-to-end. The VIP step-up test in that chapter fires an MFA push to the clinician's phone before returning a VIP chart.
