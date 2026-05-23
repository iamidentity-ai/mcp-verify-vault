Have the following installed and ready before you start chapter 5. The first run takes about 30 minutes; subsequent runs (with the bootstraps already done) are a few minutes.

## The easy path on macOS

If you are on a Mac and you want a Docker daemon WITHOUT installing Docker Desktop, the repo ships a one-shot installer that brings up Colima plus everything else this cookbook needs:

```bash
bash scripts/install-prereqs.sh
```

That installs Colima, the Docker CLIs (docker, docker-compose, docker-buildx), Node, Python 3.12, jq, git, gh, then starts Colima. Idempotent, so re-running is safe. You still have to install the Verify mobile app, get an Anthropic API key, and request the verify-rar plugin binary (see below) — those are not scriptable.

## The full list

- Docker (Colima on Mac via the script above; Docker Engine on Linux via your distro; Docker Desktop or Rancher Desktop also work).
- Node.js 22.x or newer, and npm.
- Python 3.11 or newer (3.12 is the version the install script pins).
- HashiCorp Vault CLI (optional; the bootstrap script uses the container's CLI by default).
- jq (the bootstrap scripts use it to parse JSON).
- curl (the Vault bootstrap script uses it to POST role definitions to the Vault API; standard on Mac and Linux).
- An IBM Verify tenant where you can create OIDC applications and access policies.
- The IBM Verify mobile app installed on a phone, with a userPresence (push) factor enrolled for the clinician test account. The VIP step-up smoke test in chapter 10 fires a push to that device; without an enrolled factor the VIP read returns `mfa_no_factor` (see [troubleshooting #8](./troubleshooting.md#8-vip-read-fails-with-mfa_no_factor-user-has-no-registered-userpresence-factor)). The non-VIP read still works without it.
- An LLM API key. The default in chapter 9 is Anthropic direct (`ANTHROPIC_API_KEY` from `console.anthropic.com`). If you want a different provider, see [Swapping the LLM](./llm-options.md) for what you need instead.
- The verify-rar plugin binary. The plugin source is being prepared for public release; until it lands, request a build (and the source archive for an audit) by emailing **support@iamidentity.ai**. See [Configure HashiCorp Vault](./vault-setup.md) for where the binary goes.
- Around 30 minutes for the first run.

No AWS account is required. The cookbook stack is fully local: Docker for PostgreSQL and Vault, a Node process for the MCP server, a Python process for the agent. Hosting the agent on a cloud platform is your customer's call and not part of this cookbook.
