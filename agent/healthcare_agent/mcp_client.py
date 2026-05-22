"""Per-request MCP client.

Strands' MCPClient takes a static header dict per instance; per-call dynamic
headers are an open SDK feature request. So we build a FRESH MCPClient per
agent invocation, carrying that request's user Bearer token.

The token is the RFC 8693 ``subject_token`` from the perspective of the MCP
server — it uses the token to do Token Exchange against IBM Verify. The
agent itself never inspects the token or makes any authorization decision.
"""
from mcp.client.streamable_http import streamablehttp_client
from strands.tools.mcp.mcp_client import MCPClient


def _bearer_headers(user_token: str) -> dict[str, str]:
    if not user_token:
        return {}
    return {"authorization": f"Bearer {user_token}"}


def build_mcp_client(mcp_url: str, user_token: str) -> MCPClient:
    """Build (do not enter) an MCPClient for ``mcp_url`` carrying ``user_token``.

    Caller uses it as a context manager:

        with build_mcp_client(url, tok) as client:
            tools = client.list_tools_sync()
    """
    headers = _bearer_headers(user_token)
    return MCPClient(
        lambda: streamablehttp_client(
            mcp_url,
            headers=headers,
            timeout=120,
            terminate_on_close=False,
        )
    )
