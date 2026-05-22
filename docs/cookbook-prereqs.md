Have the following installed and ready before you start chapter 5. The first run takes about 30 minutes; subsequent runs (with the bootstraps already done) are a few minutes.

- Docker (Docker Desktop on Mac, Docker Engine on Linux, 4.x or newer; Rancher Desktop running `dockerd` also works).
- Node.js 22.x and npm.
- Python 3.11 or newer.
- HashiCorp Vault CLI (optional; the bootstrap script uses the container's CLI by default).
- jq (the bootstrap scripts use it to parse JSON).
- curl (the Vault bootstrap script uses it to POST role definitions to the Vault API; standard on Mac and Linux).
- An IBM Verify tenant where you can create OIDC applications and access policies.
- The IBM Verify mobile app installed on a phone, with a userPresence (push) factor enrolled for the clinician test account. The VIP step-up smoke test in chapter 10 fires a push to that device; without an enrolled factor the VIP read returns `mfa_no_factor` (see [troubleshooting #8](./troubleshooting.md#8-vip-read-fails-with-mfa_no_factor-user-has-no-registered-userpresence-factor)). The non-VIP read still works without it.
- An LLM API key. The default in chapter 9 is Anthropic direct (`ANTHROPIC_API_KEY` from `console.anthropic.com`). If you want a different provider, see [Swapping the LLM](./llm-options.md) for what you need instead.
- Around 30 minutes for the first run.

No AWS account is required. The cookbook stack is fully local: Docker for PostgreSQL and Vault, a Node process for the MCP server, a Python process for the agent. Hosting the agent on a cloud platform is your customer's call and not part of this cookbook.
