## LLM Options

The agent is built on the Strands framework, which abstracts the LLM provider behind a single `Agent` interface. The same agent code, the same tools, the same MCP server, the same IBM Verify and HashiCorp Vault chain, all work against four different model providers. This chapter is the table that says how to switch.

## The four providers

The agent ships with adapters for Anthropic direct (the cookbook default), AWS Bedrock (Anthropic on Bedrock), OpenAI, and Google Gemini. Pick one based on what your organization is licensed for. None of them changes the identity or authorization chain; only the model that produces the next token changes.

| Provider | `LLM_PROVIDER` value | Extra to install | Required env vars | Default model id |
|---|---|---|---|---|
| Anthropic direct (default) | `anthropic` | none (default) | `ANTHROPIC_API_KEY` | `claude-sonnet-4-5-20250929` |
| AWS Bedrock (Anthropic) | `bedrock` | `pip install -e '.[bedrock]'` | `AWS_REGION`, AWS credentials via the SDK chain | `us.anthropic.claude-sonnet-4-5-20250929-v1:0` |
| OpenAI | `openai` | `pip install -e '.[openai]'` | `OPENAI_API_KEY` | `gpt-4o` |
| Google Gemini | `gemini` | `pip install -e '.[gemini]'` | `GEMINI_API_KEY` | `gemini-2.0-flash` |

Set `LLM_PROVIDER` in `agent/.env`. If you switch providers, also set the matching API key (or AWS credentials for Bedrock). Restart `uvicorn` for the change to take effect.

## The agent does not care which one you pick

Everything below the model layer is provider-independent. The tools (`list_patients_for_clinician`, `get_patient_record`) are the same. The MCP server protocol is the same. The IBM Verify Token Exchange does not see what model the agent used. The Rich Authorization Request is identical regardless of provider. The HashiCorp Vault flow, the ephemeral PostgreSQL role, and the SELECT all happen the same way. Swap the model, the identity chain does not move.

## Why Anthropic direct by default

Two reasons. First, the cookbook's customer story is "this is the identity pattern for an MCP server; pick your hosting" — and the lowest-friction LLM path that does not couple the cookbook to a cloud vendor is Anthropic direct. You generate an `ANTHROPIC_API_KEY` at `console.anthropic.com`, drop it in `.env`, and start `uvicorn`. No cloud account, no role chain, no Bedrock model-access form to submit.

Second, Strands' default Claude Sonnet 4.5 builds on Anthropic's strongest tool-use model. The OpenAI and Gemini adapters work but their tool-calling reliability is below Claude on this cookbook's scenarios; pick them when your organization is committed to that provider, not because they are technically superior here.

## Why Bedrock if you have an AWS account

Bedrock is the AWS-native path. When your organization already has AWS credentials in place (IAM roles, KMS keys, billing), Bedrock model invocations bill through the same account and the credentials chain through the same SDK. The default model id (`us.anthropic.claude-sonnet-4-5-20250929-v1:0`) is the US cross-region inference profile, which AWS recommends over the global profile for production traffic.

Bedrock is the right call for customers who have already pushed their entire AI estate through Bedrock. It is not the right call for a fresh evaluation; Anthropic direct lets your customer judge the pattern without standing up an AWS account first.

## Local models (no vendor)

Strands does not currently ship a first-class adapter for local LLM servers (Ollama, vLLM, llama.cpp). If you need to run fully air-gapped:

1. Run an OpenAI-compatible local LLM server (Ollama and vLLM both expose one).
2. Set `LLM_PROVIDER=openai` and point `OPENAI_API_BASE` at your local server (the OpenAI Python SDK respects this env var).
3. Use a model that is good enough at tool use; Llama 3.1 70B is the realistic ceiling for laptops with GPU access, and its tool-use quality is noticeably below Claude Sonnet.

The security chain stays identical — IBM Verify still authorizes, HashiCorp Vault still mints the ephemeral credential. Only the model changes. This path is supported but not tested by the cookbook's smoke test.

## What you just did

You read the four-row table that says what to install and what env vars to set for each LLM provider, and you confirmed that the identity chain does not change when you swap the model.

## What you'll do next

If you have not run [End-to-end smoke test](./smoke-test.md) yet, do that. If you have, move on to [Anatomy of an MCP Call](./mcp-anatomy.md) to walk the code that implements the security chain, or [Troubleshooting](./troubleshooting.md) if you have hit a snag.
