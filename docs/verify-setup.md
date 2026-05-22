## Verify Deployment

IBM Verify is the policy decision point for every action the agent takes. Before any of the other pieces work you need three things on your tenant: a **custom attribute** that recognizes the healthcare Rich Authorization Request (RAR), an **access policy** that triggers step-up MFA for VIP reads, and the **two OIDC applications** the agent and the MCP server use (a UI app for clinician sign-in, a Token Exchange app for the on-behalf-of flow). A small bootstrap script in `infra/verify/` creates all of this for you once you give it admin credentials.

## Pre-requisite: create the admin API client

The bootstrap script calls the IBM Verify admin API. That API needs its own API client with the right entitlements. Create it once in the Admin UI; the rest of this chapter is scripted.

1.  Sign in to your IBM Verify Admin UI at `https://<your-tenant>.verify.ibm.com`.
2.  Open **Security** -> **API**, click **Create API client**, and name it something like `mcp-verify-vault-admin`.
3.  Under **Entitlements**, grant all five of the following. The bootstrap script touches custom attributes, access policies, OIDC apps, and per-app entitlement assignments, and each of those operations needs its own entitlement.
    *   Manage access policies
    *   Manage application entitlements
    *   Manage application lifecycle
    *   Manage attribute sources
    *   Manage entitlements
4.  Save the API client. On the resulting page, copy the **Client ID** and **Client Secret**. 

Keep both values handy. You will write them to Vault in the next step.

## Land the admin credentials in Vault

This is a privileged credential. It can modify any application, policy, or custom attribute on your tenant. Vault is already running from the previous chapter, so the credential goes straight there. It never sits in a file on disk.

```bash
docker exec -e VAULT_TOKEN=vva-dev-root-token vva-vault \
  vault kv put secret/VERIFY_ADMIN_CREDS \
    client_id=<the client id you just copied> \
    client_secret=<the client secret you just copied>
```

Expected:

```
=== Secret Path ===
secret/data/VERIFY_ADMIN_CREDS

======= Metadata =======
Key                Value
---                -----
created_time       <timestamp>
custom_metadata    <nil>
deletion_time      n/a
destroyed          false
version            1
```

The bootstrap script reads `client_id` and `client_secret` from this path on every run. If you ever rotate the admin credential in the Verify Admin UI, re-run the `vault kv put` command above; the next bootstrap run picks up the new value.

## Configure your `.env`

Move into `infra/verify/` and copy the example file:

```bash
cd infra/verify
cp .env.example .env
```

Open `.env` in your editor. Only one value needs your input:

```bash
VERIFY_TENANT_HOST=<your-tenant>.verify.ibm.com
```

The tenant host is just the hostname, not a URL; do not include `https://` and do not include a trailing slash.

The remaining variables are pre-filled with local-dev defaults that match the Vault container you brought up in the previous chapter:

```bash
VAULT_ADDR=http://127.0.0.1:8200
VAULT_TOKEN=vva-dev-root-token
```

When both are set, the bootstrap script writes the Token Exchange app's `client_secret` to Vault KV at `secret/data/VERIFY_TE_CLIENT_SECRET`. The MCP server reads it from there at runtime, so it never has to live in `mcp-server/.env`. If you blank these out, the bootstrap prints the secret to your terminal for manual paste; that fallback exists for any customer who wants to adopt this pattern without standing up Vault first.

## Run the probe

A small read-only check confirms your tenant is reachable and your admin credentials work. Run it first so you do not waste time debugging the bootstrap with bad creds.

```bash
npm install
npm run probe
```

Expected:

```
Verify reachable: OK
  Tenant: <your-tenant>.verify.ibm.com
  Admin client id: a1b2c3d4... (from vault)
```

The first line is the success signal. The two indented lines echo back the tenant host, the first eight characters of your admin client id, and where the script loaded the credential from. `from vault` confirms that the `vault kv put` step landed cleanly; `from env` means the script fell back to reading `VERIFY_ADMIN_CLIENT_*` out of `.env`.

If the probe fails, three things to check, in order:

1.  Did you copy the client secret correctly? Open the admin application in the UI, regenerate the secret if you are not sure, and put the new value into `.env`.
2.  Is your tenant host correct? Run `curl -s https://<your-tenant>.verify.ibm.com/oauth2/.well-known/openid-configuration | head` and confirm you see a JSON document.
3.  Does the admin client actually have the five entitlements (Manage access policies, Manage application entitlements, Manage application lifecycle, Manage attribute sources, Manage entitlements)? Open the app in the UI, scroll to **Entitlements**, verify the list.

## Run the bootstrap

The bootstrap is idempotent. It checks for each object before creating it; running twice does not duplicate anything.

```bash
npm run bootstrap
```

Expected output (abridged):

```
[verify] attribute healthcareVipRequest created (id <attr-id>)
[verify] policy Healthcare-VIP-Step-Up created (id <policy-id>)
[verify] NOTE: API-created policies start in IDLE state. Open the policy in the Verify Admin UI, click Save, then Publish, so it transitions to ACTIVE before binding it to the TE app.
[verify] app Healthcare-UI created (id <app-id>, clientId <ui-client-id>)
[verify] app Healthcare-Token-Exchange created (id <app-id>, clientId <te-client-id>)
[verify] wrote TE client secret to Vault at secret/data/VERIFY_TE_CLIENT_SECRET

--------------------------------------------------------------
 Verify bootstrap complete. Wrote verify-output.json

 Copy these into your other .env files:
   VERIFY_TENANT_HOST=<your-tenant>.verify.ibm.com
   VERIFY_UI_CLIENT_ID=<ui-client-id>
   VERIFY_TE_CLIENT_ID=<te-client-id>

 VERIFY_TE_CLIENT_SECRET is in Vault at secret/data/VERIFY_TE_CLIENT_SECRET.
 The MCP server reads it from Vault, so DO NOT put it in mcp-server/.env.

 IMPORTANT: open the access policy in the Verify Admin UI, click
 Save then Publish so it goes ACTIVE. API-created policies sit in
 IDLE state until you do this once.
--------------------------------------------------------------
```

Three values to copy into `mcp-server/.env` later: `VERIFY_TENANT_HOST`, `VERIFY_UI_CLIENT_ID`, `VERIFY_TE_CLIENT_ID`. **The Token Exchange client secret is in Vault now**, not in any `.env` file. The MCP server fetches it from `secret/data/VERIFY_TE_CLIENT_SECRET` on its first Token Exchange call and caches it in process for five minutes. This is the design promise of the cookbook: the MCP server's `.env` holds one static credential (its Vault token), and Vault holds everything else.

If an object already exists from a prior run, the script prints `updated` instead of `created` and leaves the existing object in place. That is the intended idempotency: you can re-run the bootstrap to recover from a partial failure without duplicating anything.

The script also writes a `verify-output.json` file in the same directory; keep it around because the smoke-test chapter reads `VERIFY_UI_CLIENT_ID` out of it to drive the PKCE token grab.

### If your environment has no Vault

The bootstrap detects this by reading `VAULT_ADDR` + `VAULT_TOKEN` from this directory's `.env`. When both are blank, the script skips the Vault write and prints the TE secret in the copy-paste block instead:

```
 Copy these into your other .env files:
   VERIFY_TENANT_HOST=<your-tenant>.verify.ibm.com
   VERIFY_UI_CLIENT_ID=<ui-client-id>
   VERIFY_TE_CLIENT_ID=<te-client-id>
   VERIFY_TE_CLIENT_SECRET=<te-client-secret>

 (No Vault KV write happened. Set VAULT_ADDR + VAULT_TOKEN in this
  directory's .env to land the secret in Vault automatically.)
```

In that case you paste all four values into `mcp-server/.env`. The MCP server's secret loader falls back to the env var when Vault is not reachable, so the same code runs against either pattern. This fallback exists for any customer adopting the pattern in a stack without Vault; the cookbook's local stack always has Vault, so you will not normally see this.

## Publish the access policy in the UI

This is the step that catches first-time users. **Access policies created via the IBM Verify admin API land in state `DRAFT`. They do not evaluate.** You have to open the policy in the Admin UI and click Save and Publish to move it to `PUBLISHED`. Until you do, the Token Exchange will allow the VIP read with no step-up MFA, which is the opposite of what you want.

1.  In the Admin UI, open **Security** then **Policies**.
2.  Find **Healthcare-VIP-Step-Up** in the list.
3.  Click it to open the policy editor.
4.  Without changing anything, click **Save** at the bottom right.
5.  Click **Publish**.
6.  Refresh the policy list. The state column should now read **PUBLISHED**.

Verify the change in the Admin UI: the **State** column for `Healthcare-VIP-Step-Up` should now read **PUBLISHED**. (The probe script does a tenant reachability check only and does not inspect policy state, so it is not the right tool for this verification.)

## Rollback

If you want to undo the bootstrap (for instance, you want a clean tenant before re-running with a different name), the rollback script removes everything the bootstrap created.

```bash
npm run rollback
```

Expected:

```
[rollback] OIDC app Healthcare-Token-Exchange: DELETED
[rollback] OIDC app Healthcare-UI: DELETED
[rollback] Access policy Healthcare-VIP-Step-Up: DELETED
[rollback] Custom attribute healthcareVipRequest: DELETED
```

Rollback does not delete your admin API Access application; that one you created by hand in the UI and you keep using it.

## What you just did

You created one admin client by hand, ran a probe that confirmed your credentials work, ran a bootstrap that created the custom attribute, the access policy, and the two OIDC applications, and you published the policy so it actually evaluates. You have a `verify-output.json` file holding the UI and Token Exchange client ids for later chapters, and the Token Exchange client secret is in Vault KV at `secret/data/VERIFY_TE_CLIENT_SECRET` (the MCP server fetches it from there at runtime).

## What you'll do next

Move on to [Configure HashiCorp Vault](./vault-setup.md) to bring up the local Vault container, install the verify-rar plugin, and create the role that mints ephemeral PostgreSQL credentials.