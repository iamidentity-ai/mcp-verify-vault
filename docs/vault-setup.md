## Vault Deployment

HashiCorp Vault is the last-mile credential broker. It hosts the **verify-rar plugin**, which does the per-call PostgreSQL credential mint. When the MCP server presents an IBM Verify on-behalf-of (OBO) token to Vault, the plugin validates the JWT signature against the Verify JWKS, matches the Rich Authorization Request (RAR) embedded in the token against the role's `rar_mappings`, and issues a brand-new PostgreSQL role with a 5-minute lease and SELECT on the clinical schema. The agent never holds a long-lived database credential.

## Obtain the plugin binary

The verify-rar plugin is the load-bearing piece of this cookbook — it validates each OBO JWT against the Verify JWKS and mints the ephemeral PostgreSQL role. The plugin's source repository is in the process of being published; until that lands, request the latest build (or source archive for an audit) by emailing **support@iamidentity.ai**. State the OS and CPU architecture of the Vault container you intend to run it in (almost always `linux/arm64` for Apple Silicon Macs running Docker Desktop, or `linux/amd64` for Intel Macs / Linux developers).

Once you have the binary, copy it into the mounted plugins directory of this repository:

```bash
cp vault-plugin-secrets-verify-rar \
   <path-to>/mcp-verify-vault/infra/vault/plugins/
```

Expected: the file lands at `infra/vault/plugins/vault-plugin-secrets-verify-rar` and is executable (`chmod +x` if not). The bootstrap script in the next section computes the SHA-256 itself before registering the plugin with Vault, so you do not need to compute it by hand.

There is a separate companion plugin that rotates IBM Verify client secrets out of Vault. **You do not need it for this cookbook.** It is useful when many production services need their own rotating Verify client; here, a single 24-hour Vault token for the MCP server is sufficient.

## Deploying the plugin to other Vault environments

The plugin binary has to match the OS and CPU architecture of the **Vault process itself**, not the developer's laptop. The cookbook's local Vault runs inside a Docker container, so the binary has to be a Linux binary for that container's architecture. If you are taking the plugin to a different Vault deployment, request the matching build from support@iamidentity.ai, or (once you have the plugin source archive) build for that target. Five common scenarios:

| Scenario | Where Vault runs | Build command |
|---|---|---|
| Cookbook on Apple Silicon Mac | Docker Desktop, Linux arm64 container | `GOOS=linux GOARCH=arm64 make build` |
| Cookbook on Intel Mac | Docker Desktop, Linux amd64 container | `GOOS=linux GOARCH=amd64 make build` |
| Linux developer with native Docker | Linux container matches host architecture | `make build` (no cross-compile needed) |
| Linux + k3s (Kubernetes) | Pod on a k3s node, Linux + node architecture | On a node of the matching arch: `make build`. Cross-compiling from a Mac: `GOOS=linux GOARCH=amd64 make build` (most k3s nodes are amd64). |
| Red Hat Enterprise Linux, Vault binary running natively | RHEL host directly, almost always amd64 | On the RHEL host: `make build`. Cross-compiling from a Mac: `GOOS=linux GOARCH=amd64 make build`. |

After building, the binary has to land somewhere Vault can read it. The exact path depends on the deployment shape:

**Cookbook (Docker Desktop):** copy the binary into `infra/vault/plugins/`. The dev container has this directory mounted at `/vault/plugins/` (read-only), and the bootstrap script registers the binary by SHA. Nothing else to do.

**Linux + k3s:** the cleanest path is to bake the binary into a custom Vault image. Write a small `Dockerfile FROM hashicorp/vault:1.18 ... COPY vault-plugin-secrets-verify-rar /vault/plugins/`, push to your registry, and point the official Vault Helm chart at it via `injector.image` overrides. ConfigMap-plus-init-container works too but the plugin binary is around 30 MB which is close to ConfigMap's 1 MB limit, so a custom image is the maintainable choice. PVC plus manual `kubectl cp` works for one-time evaluation but is fragile for ongoing deployments.

**RHEL non-container:** copy the binary to `/etc/vault.d/plugins/vault-plugin-secrets-verify-rar` (or whatever `plugin_directory` your `vault.hcl` declares), `chown vault:vault`, `chmod 0750`. If SELinux is enforcing on the host, `chcon -t bin_t /etc/vault.d/plugins/vault-plugin-secrets-verify-rar` or write a small policy module. Then register in the catalog and enable the secrets engine the same way the bootstrap script does:

```bash
SHA=$(sha256sum /etc/vault.d/plugins/vault-plugin-secrets-verify-rar | awk '{print $1}')
vault plugin register -sha256=${SHA} secret vault-plugin-secrets-verify-rar
vault secrets enable -path=verify-rar -plugin-name=vault-plugin-secrets-verify-rar plugin
```

No Vault restart is needed for plugin registration. You only restart if you changed `plugin_directory` in `vault.hcl`.

**HCP Vault Dedicated (HashiCorp's SaaS):** customer-uploaded plugins are not supported. HashiCorp manages the binary surface of HCP Vault; you cannot drop in `vault-plugin-secrets-verify-rar` and there is no upload mechanism. If your customer is committed to HCP Dedicated, you have three options.

1. **Run a small self-managed Vault alongside HCP.** HCP holds whatever the customer originally chose it for; a separate self-managed Vault (Enterprise or OSS) hosts the verify-rar plugin. The MCP server is configured with two Vault addresses, one for static service secrets and one for the per-call mint. Workable but architecturally noisy.
2. **Move the verify-rar logic into the MCP server itself.** The plugin's job is to validate the OBO claims against `rar_mappings` and mint a Postgres role. None of that strictly requires Vault. The MCP server can perform the same check directly against Postgres, with HCP Vault holding only the static service secrets. You lose the Vault audit trail for per-call mints, but you keep the per-call RAR check.
3. **Stay self-managed for Vault, use HCP for non-Vault services only.** If the customer's HCP investment is in other HashiCorp services (HCP Boundary, HCP Consul, HCP Packer), this is often the simplest answer.

If HashiCorp opens a customer-plugin-upload feature on HCP Dedicated later (they have hinted at it but have not committed to a date), revisit option 1 and you can collapse to a single Vault deployment.

## Bring up Vault

The local stack runs Vault in dev mode inside a container. Dev mode auto-unseals on every start and has its own root token printed in the logs; this is intentional for a local-only walkthrough. Do not point production traffic at a dev-mode Vault.

```bash
cd infra
docker compose up -d vault
```

Expected: `Container vva-vault Started`.

Wait a few seconds for Vault to initialize, then confirm it is responding:

```bash
curl -s http://127.0.0.1:8200/v1/sys/health | jq
```

Expected (abridged):

```json
{
  "initialized": true,
  "sealed": false,
  "standby": false
}
```

If `sealed` is `true`, your container did not start in dev mode. Check `docker logs vva-vault` and confirm you see `Root Token:` near the top.

## Configure infra/.env before bootstrapping

The bootstrap script reads its inputs from `infra/.env`. The Docker compose stack reads the same file for the Vault dev token and the Postgres admin credentials, so this one file feeds both. Copy the example and fill in your Verify tenant hostname:

```bash
cp infra/.env.example infra/.env
```

Open `infra/.env` and set the one value that has no safe default:

```bash
VERIFY_TENANT_HOST=<your-tenant>.verify.ibm.com
```

The remaining values match the local Vault container and Postgres container the cookbook brings up; they are pre-filled and you do not need to change them unless you are pointing at a different stack:

```bash
POSTGRES_ADMIN_USER=vva_admin
POSTGRES_ADMIN_PASSWORD=vva_admin_local_dev_only
POSTGRES_DB=healthcare
VAULT_ADDR=http://127.0.0.1:8200
VAULT_DEV_ROOT_TOKEN=vva-dev-root-token
```

If you set `VERIFY_TENANT_HOST` and run the bootstrap, the script synthesizes the full URL (`https://${VERIFY_TENANT_HOST}`) and the JWKS endpoint (`${VERIFY_TENANT_HOST}/oauth2/jwks`) automatically.

## Run the bootstrap

The bootstrap registers the plugin in Vault's catalog, enables the secrets engine at `verify-rar/`, writes the database connection config, writes the role and its `rar_mappings`, writes the access policy for the MCP server, and mints a 24-hour token for the MCP server to use.

```bash
bash infra/vault/bootstrap-vault.sh
```

Expected output (abridged):

```
[vault-bootstrap] Plugin registered: vault-plugin-secrets-verify-rar
[vault-bootstrap] Secrets engine enabled at verify-rar/
[vault-bootstrap] Database connection healthcare-postgres: WRITTEN
[vault-bootstrap] Role healthcare-records: WRITTEN
[vault-bootstrap] Policy healthcare-mcp: WRITTEN

================================================================
 MCP-server Vault token (paste into mcp-server/.env as VAULT_TOKEN):
   hvs.AAAA...
 TTL: 24h
================================================================
```

Copy the printed `hvs....` token. You will paste it into `mcp-server/.env` as `VAULT_TOKEN` in chapter 7 (Start the MCP server). The token is renewable, so 24 hours is a forgiving window for a local development session.

## What the bootstrap just did

Five Vault objects exist now. Read the list once so the `VAULT_ROLE=healthcare-records` value the MCP server uses in chapter 7 is unsurprising.

1.  **The plugin in the catalog.** Vault knows about `vault-plugin-secrets-verify-rar` and the binary it can execute.
2.  **The secrets engine mounted at `verify-rar/`.** This is the path the MCP server POSTs to: `POST /v1/verify-rar/creds/healthcare-records`.
3.  **The database connection config.** Vault holds the credentials for an admin PostgreSQL role (`vva_admin`) that has the right to `CREATE ROLE`, `GRANT`, and `DROP ROLE` against the `clinical` schema.
4.  **The role `healthcare-records`.** The role definition includes the SQL template that mints a new ephemeral role with SELECT on `clinical.patients`, `clinical.visits`, and `clinical.clinicians`, plus the `rar_mappings` that say which RAR shapes are allowed to use this role.
5.  **The KV v2 secrets engine at `secret/`.** Vault dev mode mounts this by default; the bootstrap re-asserts it so the same script works against a non-dev Vault. The Verify bootstrap from the previous chapter writes the Token Exchange `client_secret` here at `secret/data/VERIFY_TE_CLIENT_SECRET`; if you ran the chapters in order, that value is already in Vault.
6.  **The policy `healthcare-mcp`.** This is the Vault policy attached to the 24-hour token. It grants `update` on `verify-rar/creds/healthcare-records`, `update` on `sys/leases/revoke`, and `read` on `secret/data/VERIFY_TE_CLIENT_SECRET` so the MCP server can fetch its own service secret from Vault rather than reading it from `.env`.

## Common gotcha: the policy needs `update`, not `read`

The verify-rar plugin path `verify-rar/creds/<role>` is registered for both Vault's `ReadOperation` and `UpdateOperation`. Vault's HTTP layer does not deserialize a JSON request body on a GET, so the plugin needs a POST. POST corresponds to `update` in Vault's capability model.

If you write a policy that grants only `read` on this path, your CLI test with `vault read` will work fine (it goes through the read path), but the workload will get a silent HTTP 403 because it POSTs (which goes through the update path). The included `healthcare-mcp.hcl` policy grants **both** capabilities; you do not need to do anything. This note is for any future contributor who writes a new policy and stares at a 403 for an hour.

## What you just did

You built the verify-rar plugin from source, dropped the binary into the mounted plugins directory, brought up a local dev-mode Vault, and ran the bootstrap that created the role, the policy, and a 24-hour token for the MCP server. You wrote down the `hvs.` token; chapter 7 (Start the MCP server) wants it.

## What you'll do next

Move on to [Configure PostgreSQL](./postgres-setup.md) to bring up the clinical database with its seeded patient data, then on to the MCP server itself.