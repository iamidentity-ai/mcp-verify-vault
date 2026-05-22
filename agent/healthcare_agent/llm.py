"""LLM provider abstraction for the healthcare agent.

Reads ``LLM_PROVIDER`` from env and returns a Strands-compatible model.
Default is ``anthropic`` (Anthropic direct). Supported values:
``anthropic``, ``bedrock``, ``openai``, ``gemini``.

For each non-default provider, install the matching pyproject extra first:

    pip install -e '.[bedrock]'   # adds boto3 for AWS Bedrock
    pip install -e '.[openai]'    # adds strands-agents[openai]
    pip install -e '.[gemini]'    # adds strands-agents[gemini]
"""
from __future__ import annotations

import os
from typing import Any


def make_model() -> Any:
    """Return a Strands model instance based on the ``LLM_PROVIDER`` env var."""
    provider = os.getenv("LLM_PROVIDER", "anthropic").lower()

    if provider == "anthropic":
        # Anthropic direct. Requires ANTHROPIC_API_KEY.
        from strands.models import AnthropicModel
        return AnthropicModel(
            model_id=os.getenv("ANTHROPIC_MODEL_ID", "claude-sonnet-4-5-20250929"),
            api_key=os.environ["ANTHROPIC_API_KEY"],
        )

    if provider == "bedrock":
        # AWS Bedrock Anthropic. SDK uses the standard AWS credential chain.
        # Requires the `bedrock` extra (boto3).
        from strands.models import BedrockModel
        return BedrockModel(
            model_id=os.getenv("BEDROCK_MODEL_ID", "us.anthropic.claude-sonnet-4-5-20250929-v1:0"),
            region_name=os.getenv("AWS_REGION", "us-east-1"),
        )

    if provider == "openai":
        # OpenAI. Requires OPENAI_API_KEY and the `openai` extra.
        from strands.models import OpenAIModel
        return OpenAIModel(
            model_id=os.getenv("OPENAI_MODEL_ID", "gpt-4o"),
            api_key=os.environ["OPENAI_API_KEY"],
        )

    if provider == "gemini":
        # Google Gemini. Requires GEMINI_API_KEY and the `gemini` extra.
        from strands.models import GeminiModel
        return GeminiModel(
            model_id=os.getenv("GEMINI_MODEL_ID", "gemini-2.0-flash"),
            api_key=os.environ["GEMINI_API_KEY"],
        )

    raise ValueError(
        f"Unknown LLM_PROVIDER={provider!r}. "
        "Supported: anthropic (default), bedrock, openai, gemini."
    )
