# healthcare-agent

A small FastAPI server hosting a Strands agent loop. The agent forwards
the inbound clinician token to the MCP server and streams the model's
text response back as Server-Sent Events.

## Run

```bash
python3.11 -m venv .venv && source .venv/bin/activate
pip install -e .
cp .env.example .env  # fill in ANTHROPIC_API_KEY
uvicorn healthcare_agent.main:app --host 127.0.0.1 --port 8080 --reload
```

The server listens on `http://127.0.0.1:8080`. `GET /healthz` returns
`{"status":"ok"}`. `POST /invoke` takes `Authorization: Bearer <clinician-token>`
and a JSON body `{"prompt": "..."}`, streaming SSE chunks back.

## Where this fits in the cookbook

This is chapter 9 ("Run the agent") of the cookbook. The chapter walks
through installing the dependencies, configuring `.env`, and running
the smoke test against this server. See `../docs/agent-setup.md`.
