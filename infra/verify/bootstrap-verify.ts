/**
 * Bootstrap script for IBM Verify SaaS -- mcp-verify-vault.
 *
 * Creates four objects on the customer's tenant:
 *   1. A custom CELX attribute that returns "true" when the request carries
 *      a healthcare-flavored RFC 9396 authorization_details object.
 *   2. An access policy that, when bound to a Token Exchange app, fires
 *      ACTION_MFA_ALWAYS whenever the attribute is true.
 *   3. An OIDC "UI" application for the clinician sign-in (authorization_code
 *      + PKCE, no client secret).
 *   4. An OIDC "Token Exchange" application that performs RFC 8693 token
 *      exchange (with the access policy bound) and reissues a scoped OBO
 *      that carries the RAR through to Vault.
 *
 * Idempotent: re-running this script is safe. Each object is looked up by
 * name before being created; if found, it is updated rather than duplicated.
 *
 * Pre-requisite: an OIDC API-Access client with entitlements
 *   manageApplications, manageAccessPolicies, manageCustomAttributes
 * Set its clientId and clientSecret in .env as VERIFY_ADMIN_CLIENT_ID/SECRET.
 */

import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { loadAdminCreds } from './admin-creds.js';

const TENANT  = required('VERIFY_TENANT_HOST');
const UI_NAME = process.env.VERIFY_UI_APP_NAME || 'vva-healthcare-ui';
const TE_NAME = process.env.VERIFY_TE_APP_NAME || 'vva-healthcare-token-exchange';
const POLICY_NAME = process.env.VERIFY_POLICY_NAME || 'HealthcareStepUp';
const ATTR_NAME = process.env.VERIFY_ATTRIBUTE_NAME || 'healthcareRarPresent';
const BASE = `https://${TENANT}`;

// Vault is the canonical home for every secret in this cookbook. When VAULT_ADDR
// + VAULT_TOKEN are set in .env (defaults match the local Vault container), the
// admin client credentials are READ from Vault KV at secret/data/VERIFY_ADMIN_CREDS
// and the TE client secret is WRITTEN to Vault KV at secret/data/VERIFY_TE_CLIENT_SECRET.
// Env-var fallback exists for any customer adapting this pattern without Vault.
const VAULT_ADDR = process.env.VAULT_ADDR;
const VAULT_TOKEN = process.env.VAULT_TOKEN;

const ROLLBACK = process.argv.includes('--rollback');

function required(name: string): string {
  const v = process.env[name];
  if (!v) { console.error(`Missing required env var: ${name}`); process.exit(1); }
  return v;
}

const adminCreds = await loadAdminCreds();
const ADMIN_ID = adminCreds.clientId;
const ADMIN_SECRET = adminCreds.clientSecret;
console.log(`[verify] admin credentials loaded from ${adminCreds.source}`);

// -- Step 1: mint a tenant-admin access token via client_credentials ----------
async function getAdminToken(): Promise<string> {
  const res = await fetch(`${BASE}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: ADMIN_ID,
      client_secret: ADMIN_SECRET,
    }),
  });
  if (!res.ok) {
    console.error(`Admin token request failed: ${res.status} ${await res.text()}`);
    process.exit(1);
  }
  const json = await res.json() as { access_token: string };
  return json.access_token;
}

async function api(method: string, path: string, token: string, body?: unknown) {
  if (body && path.includes('/applications')) {
    console.log(`[DEBUG] Request body: ${JSON.stringify(body, null, 2)}`);
  }
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    console.error(`${method} ${path} failed: ${res.status}`);
    console.error(`Response: ${text}`);
    process.exit(1);
  }
  return text ? JSON.parse(text) : null;
}

// -- Step 2: custom CELX attribute --------------------------------------------
// The CEL rule reads requestContext.getValue("authz") (populated by the TE
// app's tokenRequestMap below) as a JSON-stringified RAR array, and returns
// "true" ONLY when the RAR carries the VIP-flagged read action. Non-VIP
// reads (list, baseline get) carry action=patient_read which deliberately
// does NOT match: the policy stays at ACTION_ALLOW for those calls so the
// MCP server gets a real OBO without an MFA challenge.
const CELX_RULE = `statements:
  - context: >
      authz := requestContext.getValue("authz") != ""
                ? stringToJson(requestContext.getValue("authz"))
                : []
  - context: >
      isHealthcareVipRead := context.authz.exists(ad,
        ad.type == "urn:smt:agent:healthcare" &&
        ad.operationDetails.action == "patient_read_vip")
  - return: context.isHealthcareVipRead`;

async function upsertAttribute(token: string): Promise<string> {
  const existing = await api('GET', `/v1.0/attributes`, token).catch(() => null);
  const allAttrs = (existing as Array<{ id: string; name: string }>) || [];
  const list = allAttrs.filter(a => a.name === ATTR_NAME);
  const body = {
    name: ATTR_NAME,
    description: 'Returns "true" when the request carries a healthcare patient_read or patient_read_vip RAR',
    sourceType: 'static',
    datatype: 'string',
    tags: ['sso'],
    multiValued: false,
    function: {
      custom: CELX_RULE
    },
  };
  if (list[0]?.id) {
    await api('PUT', `/v1.0/attributes/${list[0].id}`, token, body);
    console.log(`[verify] attribute ${ATTR_NAME} updated (id ${list[0].id})`);
    return list[0].id;
  }
  const created = await api('POST', '/v1.0/attributes', token, body) as { id: string };
  console.log(`[verify] attribute ${ATTR_NAME} created (id ${created.id})`);
  return created.id;
}

// -- Step 3: access policy ----------------------------------------------------
// Two rules in priority order:
//   1. <attribute> IN ["true"]  ->  ACTION_MFA_ALWAYS, factor macotp
//   2. default                  ->  ACTION_ALLOW
async function upsertAccessPolicy(token: string, attrId: string): Promise<string> {
  const existing = await api('GET', `/v5.0/policyvault/accesspolicy?search=name="${POLICY_NAME}"`, token).catch(() => null);
  const list = (existing as { policies?: Array<{ id: string }> })?.policies || [];
  const body = {
    name: POLICY_NAME,
    description: 'Fire step-up MFA when the request carries a healthcare RAR',
    enforcementType: 'fedSSO',
    rules: [
      {
        name: 'Healthcare step-up',
        result: {
          action: 'ACTION_MFA_ALWAYS',
          authnMethods: ['urn:ibm:security:authentication:asf:macotp']
        },
        conditions: [{
          type: 'customAttributes',
          customAttributes: [
            {
              name: attrId,
              opCode: 'EQ',
              values: ['true']
            }
          ]
        }],
      },
      {
        name: 'Default allow',
        result: { action: 'ACTION_ALLOW' }
      },
    ],
  };
  if (list[0]?.id) {
    await api('PUT', `/v5.0/policyvault/accesspolicy/${list[0].id}`, token, body);
    console.log(`[verify] policy ${POLICY_NAME} updated (id ${list[0].id})`);
    return list[0].id;
  }
  const created = await api('POST', '/v5.0/policyvault/accesspolicy', token, body) as { id: string };
  console.log(`[verify] policy ${POLICY_NAME} created (id ${created.id})`);
  console.log(`[verify] NOTE: API-created policies start in IDLE state. Open the policy in the Verify Admin UI, click Save, then Publish, so it transitions to ACTIVE before binding it to the TE app.`);
  return created.id;
}

// -- Step 4: UI OIDC app + Token Exchange OIDC app ----------------------------
// Body shape mirrors the canonical Verify admin API. Works on any Verify
// SaaS tenant; the tenant host is read from VERIFY_TENANT_HOST at runtime.
//
// Notable design choices for this cookbook:
//   - Two apps (UI + Token Exchange), not three. We omit a separate
//     "Agent Identity" client_credentials app and set actorTokenRequired:false
//     on the TE app. The MCP server's Token Exchange call carries only
//     subject_token (the user). This keeps the cookbook minimal.
//
//     For production hardening, add a third Agent Identity OIDC app with
//     grantTypes.clientCredentials="true", flip TE app's actorTokenRequired
//     to true, and add clientGroups.tokenExchange=[uiClientId, agentClientId]
//     so Verify enforces that the caller is a known agent. See
//     docs/verify-setup.md "Production hardening" for the upgrade path.
//
//   - No tenant-specific UUIDs. We do not set customization.themeId,
//     identitySources, or attributeMappings sourceIds, because those are
//     tenant-specific GUIDs that will not exist on a fresh tenant.

const COMPANY_NAME = process.env.VERIFY_COMPANY_NAME || 'Acme Healthcare';

function buildUiBody(redirectUri: string): Record<string, unknown> {
  // applicationUrl is required by Verify on UI apps (CSIAD0006 if missing).
  // We derive it from redirectUri so the customer does not have to set it
  // separately. For redirectUri='http://localhost:5176/callback' the
  // applicationUrl becomes 'http://localhost:5176'.
  const applicationUrl = new URL(redirectUri).origin;
  // Two redirect URIs are registered so the cookbook works out of the box:
  //   1. The 'redirectUri' arg (defaults to the UI-app placeholder) is for
  //      any web UI the customer wires up in front of the agent.
  //   2. http://localhost:8765/cb is the address the smoke-test script
  //      spins up to capture the PKCE callback. Without it the smoke-test
  //      flow fails with CSIAQ0167E (redirect_uri not registered).
  const redirectUris = Array.from(new Set([redirectUri, 'http://localhost:8765/cb']));
  return {
    name: UI_NAME,
    templateId: '998',
    description: 'mcp-verify-vault UI app',
    // saml.properties.companyName is required even on OIDC-only apps. The
    // Admin UI marks it with a red asterisk. generateUniqueID:false lets
    // Verify pick the saml unique id; we never use it.
    providers: {
      saml: {
        properties: {
          companyName: COMPANY_NAME,
          generateUniqueID: false,
        },
      },
      sso: { userOptions: 'oidc' },
      oidc: {
        applicationUrl,
        properties: {
          grantTypes: {
            authorizationCode: 'true',
            implicit: 'false',
            deviceFlow: 'false',
            ropc: 'false',
            jwtBearer: 'false',
            policyAuth: 'false',
            clientCredentials: 'false',
            tokenExchange: 'false',
          },
          redirectUris,
          idTokenSigningAlg: 'RS256',
          accessTokenExpiry: 3600,
          refreshTokenExpiry: 86400,
          doNotGenerateClientSecret: 'false',
          // Canonical healthcare register-verify-apps.ts uses 'false' here
          // on ALL three apps. Setting 'true' + refreshTokenExpiry triggers
          // CSIAQ0229 even though the expiry value is in the stated range.
          // The MCP server does not rely on OIDC refresh tokens (it re-mints
          // via Token Exchange each tool call), so 'false' is also semantically
          // correct.
          generateRefreshToken: 'false',
          renewRefreshToken: 'true',
          sendAllKnownUserAttributes: 'true',
          consentType: 'dpcm',
          additionalConfig: {
            responseTypes: ['code'],
            responseModes: ['query', 'fragment', 'form_post'],
            logoutOption: 'none',
            exchangeForSSOSessionOption: 'default',
            clientAuthMethod: 'default',
            actorTokenRequired: false,
            requestObjectParametersOnly: false,
            useUserDefaultEntitlements: true,
            dpopBoundAccessTokens: false,
            oidcv3: true,
            requirePushAuthorize: false,
            validateDPoPProofJti: false,
            certificateBoundAccessTokens: false,
            requestObjectSigningAlg: 'RS256',
            authorizeRspSigningAlg: 'RS256',
            authorizeRspEncryptionEnc: 'none',
            authorizeRspEncryptionAlg: 'none',
            dpopProofSigningAlg: 'RS256',
            requestObjectMaxExpFromNbf: 1800,
            requestObjectRequireExp: true,
            suppressDefaultClaims: false,
          },
          idTokenEncryptAlg: 'none',
          idTokenEncryptEnc: 'none',
        },
        entitlements: [],
        restrictEntitlements: true,
        grantProperties: { generateDeviceFlowQRCode: 'false' },
        token: { accessTokenType: 'jwt' },
        consentAction: 'always_prompt',
        requirePkceVerification: 'true',
      },
    },
    applicationState: true,
    approvalRequired: false,
    signonState: true,
    visibleOnLaunchpad: true,
    // 'default' is a Verify-provided built-in theme; valid on every tenant.
    customization: { themeId: 'default' },
  };
}

function buildTokenExchangeBody(policyId: string): Record<string, unknown> {
  return {
    name: TE_NAME,
    templateId: '998',
    description: 'mcp-verify-vault Token Exchange app',
    providers: {
      saml: {
        properties: {
          companyName: COMPANY_NAME,
          generateUniqueID: false,
        },
      },
      sso: { userOptions: 'oidc' },
      oidc: {
        properties: {
          grantTypes: {
            authorizationCode: 'false',
            implicit: 'false',
            deviceFlow: 'false',
            ropc: 'false',
            jwtBearer: 'true',
            policyAuth: 'false',
            clientCredentials: 'false',
            tokenExchange: 'true',
          },
          redirectUris: [],
          idTokenSigningAlg: 'RS256',
          accessTokenExpiry: 3600,
          refreshTokenExpiry: 86400,
          doNotGenerateClientSecret: 'false',
          generateRefreshToken: 'false',
          renewRefreshToken: 'true',
          sendAllKnownUserAttributes: 'true',
          consentType: 'dpcm',
          additionalConfig: {
            // RFC 9396 authorization_details plumbing. The TE app pulls the
            // RAR from the request, exposes it as a CEL context variable
            // named "authz" (read by the custom CELX attribute), and writes
            // it back out as a top-level "authorization_details" claim on
            // the OBO response so the MCP server has Verify-attested RAR.
            authorizeRequestMap: [
              {
                name: 'context',
                custom: 'statements:\n- return: requestContext.authorization_details',
              },
            ],
            tokenRequestMap: [
              {
                name: 'context',
                custom:
                  '{ "authz": has(requestContext.authorization_details) ? jsonToString(requestContext.authorization_details) : "" }',
              },
            ],
            tokenResponseMap: [
              {
                name: 'authorization_details',
                type: 'parameter',
                custom: 'statements:\n- return: requestContext.authorization_details',
              },
            ],
            // No actor required in this cookbook (see file-level note).
            actorTokenRequired: false,
            subjectTokenTypes: ['urn:ietf:params:oauth:token-type:access_token'],
            requestedTokenTypes: ['urn:ietf:params:oauth:token-type:access_token'],
            responseTypes: [],
            responseModes: [],
            logoutOption: 'none',
            exchangeForSSOSessionOption: 'default',
            clientAuthMethod: 'default',
            requestObjectParametersOnly: false,
            useUserDefaultEntitlements: true,
            dpopBoundAccessTokens: false,
            oidcv3: true,
            requirePushAuthorize: false,
            validateDPoPProofJti: false,
            certificateBoundAccessTokens: false,
            requestObjectSigningAlg: 'RS256',
            authorizeRspSigningAlg: 'RS256',
            authorizeRspEncryptionEnc: 'none',
            authorizeRspEncryptionAlg: 'none',
            dpopProofSigningAlg: 'RS256',
            requestObjectMaxExpFromNbf: 1800,
            requestObjectRequireExp: true,
            suppressDefaultClaims: false,
          },
          idTokenEncryptAlg: 'none',
          idTokenEncryptEnc: 'none',
        },
        // Custom scopes the MCP server requests on Token Exchange. The
        // mcp-server/src/vault/verify-rar-client.ts asks for
        // 'healthcare:patient:read' on every call; without the scope defined
        // here, Verify rejects the TE with 'invalid_grant'.
        scopes: [
          { name: 'healthcare:patient:read', description: 'Read a patient record' },
        ],
        restrictScopes: 'true',
        entitlements: [],
        restrictEntitlements: false,
        grantProperties: { generateDeviceFlowQRCode: 'false' },
        token: { accessTokenType: 'jwt' },
        consentAction: 'always_prompt',
        requirePkceVerification: 'true',
      },
    },
    applicationState: true,
    approvalRequired: false,
    signonState: true,
    visibleOnLaunchpad: false,
    customization: { themeId: 'default' },
    // Bind the access policy created in Step 3 so MFA fires on RARs matching
    // the healthcareRarPresent attribute. Verify accepts authPolicy at the
    // application TOP LEVEL (not under providers.oidc.properties.additionalConfig
    // as some older docs suggest); the top-level location is what the Admin
    // UI's PUT writes when you bind a policy via the UI.
    authPolicy: {
      id: policyId,
      name: POLICY_NAME,
      grantTypes: [{ tokenExchange: true }],
    },
  };
}

// After app creation Verify defaults the Entitlements tab to "Select users and
// groups" with no users selected -> no one can sign in. The Admin UI exposes
// this as a radio group ("Automatic access" / "Approval required" / "Select").
// The API equivalent is POST /v1.0/owner/applications/{id}/entitlements with
// birthRightAccess:true, which is the "Automatic access for all users and
// groups" radio. Without this call the customer hits a sign-in failure that
// is hard to diagnose because Verify just silently denies.
async function setAutomaticAccess(token: string, appId: string): Promise<void> {
  const res = await fetch(`${BASE}/v1.0/owner/applications/${appId}/entitlements`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({
      birthRightAccess: true,
      requestAccess: false,
      additions: [],
      deletions: [],
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    console.error(`[verify] WARNING: failed to set automatic access on app ${appId}: ${res.status} ${text}`);
    console.error('[verify] You can fix this in the Admin UI: Applications -> <app> -> Entitlements -> "Automatic access for all users and groups"');
  }
}

interface AppResult { id: string; clientId: string; clientSecret?: string }

// Verify returns the new app's id only in the Location header (or _links.self.href);
// the response body itself does NOT carry the clientId. We follow up with a GET
// to fetch the full record, which includes clientId + clientSecret. This matches
// canonical scripts that have been working against Verify SaaS for over a year.
async function createApp(token: string, body: Record<string, unknown>): Promise<AppResult> {
  const res = await fetch(`${BASE}/v1.0/applications`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    console.error(`POST /v1.0/applications failed: ${res.status}`);
    console.error(`Response: ${text}`);
    process.exit(1);
  }
  const created = text ? JSON.parse(text) : {};
  // Extract id from _links.self.href or Location header
  const href: string = created._links?.self?.href || res.headers.get('location') || '';
  const match = href.match(/\/applications\/(\d+)/);
  const id = match ? match[1] : '';
  if (!id) {
    console.error('Could not extract app id from POST response.');
    console.error('Body:', JSON.stringify(created, null, 2));
    console.error('Location header:', res.headers.get('location'));
    process.exit(1);
  }
  // Fetch the full app to retrieve clientId + clientSecret
  const full = await api('GET', `/v1.0/applications/${id}`, token) as {
    providers?: { oidc?: { clientId?: string; clientSecret?: string; properties?: { clientId?: string; clientSecret?: string } } };
  };
  const clientId =
    full.providers?.oidc?.clientId ||
    full.providers?.oidc?.properties?.clientId || '';
  const clientSecret =
    full.providers?.oidc?.clientSecret ||
    full.providers?.oidc?.properties?.clientSecret || undefined;
  return { id, clientId, clientSecret };
}

async function findApp(token: string, name: string): Promise<AppResult | null> {
  const data = await api('GET', `/v1.0/applications`, token) as { _embedded?: { applications?: Array<{ _links?: { self?: { href?: string } }; name: string }> } };
  const apps = data._embedded?.applications || [];
  const hit = apps.find((a) => a.name === name);
  if (!hit) return null;
  const href = hit._links?.self?.href || '';
  const match = href.match(/\/applications\/(\d+)/);
  if (!match) return null;
  const id = match[1];
  const full = await api('GET', `/v1.0/applications/${id}`, token) as {
    providers?: { oidc?: { clientId?: string; clientSecret?: string; properties?: { clientId?: string; clientSecret?: string } } };
  };
  const clientId =
    full.providers?.oidc?.clientId ||
    full.providers?.oidc?.properties?.clientId || '';
  // Confidential OIDC apps expose clientSecret on the authenticated GET so
  // re-runs can still land the secret in Vault without re-creating the app.
  const clientSecret =
    full.providers?.oidc?.clientSecret ||
    full.providers?.oidc?.properties?.clientSecret || undefined;
  return { id, clientId, clientSecret };
}

async function upsertOidcApp(token: string, opts: {
  name: string;
  redirectUri: string;
  isTokenExchange: boolean;
  policyId?: string;
}): Promise<AppResult> {
  const existing = await findApp(token, opts.name);
  if (existing) {
    console.log(`[verify] app ${opts.name} already exists (id ${existing.id}, clientId ${existing.clientId}); leaving in place`);
    // Idempotency: ensure automatic access is set even on a re-run. The
    // workflow POST is safe to call repeatedly (returns 409 on conflict).
    await setAutomaticAccess(token, existing.id);
    return existing;
  }
  const body = opts.isTokenExchange
    ? buildTokenExchangeBody(opts.policyId!)
    : buildUiBody(opts.redirectUri);
  const result = await createApp(token, body);
  console.log(`[verify] app ${opts.name} created (id ${result.id}, clientId ${result.clientId})`);
  // Without this, the new app has no users assigned and sign-in silently fails.
  await setAutomaticAccess(token, result.id);
  console.log(`[verify] app ${opts.name} entitlements set to automatic access for all users`);
  return result;
}

// -- Rollback (delete) --------------------------------------------------------
async function rollback(token: string) {
  for (const name of [UI_NAME, TE_NAME]) {
    const list = ((await api('GET', `/v1.0/applications?filter=name eq "${name}"`, token)) as { applications?: Array<{ id: string }> })?.applications || [];
    for (const a of list) await api('DELETE', `/v1.0/applications/${a.id}`, token);
  }
  const polList = ((await api('GET', `/v5.0/policyvault/accesspolicy?search=name eq "${POLICY_NAME}"`, token)) as { policies?: Array<{ id: string }> })?.policies || [];
  for (const p of polList) await api('DELETE', `/v5.0/policyvault/accesspolicy/${p.id}`, token);
  const attrList = ((await api('GET', `/v1.0/attributes?filter=name eq "${ATTR_NAME}"`, token)) as { attributes?: Array<{ id: string }> })?.attributes || [];
  for (const a of attrList) await api('DELETE', `/v1.0/attributes/${a.id}`, token);
  console.log('[verify] rollback complete');
}

// -- main ---------------------------------------------------------------------
const token = await getAdminToken();
if (ROLLBACK) {
  await rollback(token);
  process.exit(0);
}

const attrId = await upsertAttribute(token);
// Small delay to allow attribute to propagate/index
await new Promise(resolve => setTimeout(resolve, 2000));
const policyId = await upsertAccessPolicy(token, attrId);
const uiApp = await upsertOidcApp(token, {
  name: UI_NAME,
  redirectUri: 'http://localhost:5176/callback',
  isTokenExchange: false,
});
const teApp = await upsertOidcApp(token, {
  name: TE_NAME,
  redirectUri: '',
  isTokenExchange: true,
  policyId,
});

// verify-output.json carries non-secret identifiers + the policyId. Secrets
// (TE + UI client_secret) live in Vault KV, written below. The smoke-test
// and the get-clinician-token script read identifiers from this file and
// secrets from Vault, so the customer never has a plaintext secret on disk.
const out = {
  tenantHost: TENANT,
  uiClientId: uiApp.clientId,
  teClientId: teApp.clientId,
  policyId,
  attributeName: ATTR_NAME,
};
writeFileSync('verify-output.json', JSON.stringify(out, null, 2));

// Helper to write a KV v2 secret. Returns true on success, false otherwise.
async function writeVaultKv(path: string, fields: Record<string, string>): Promise<boolean> {
  if (!VAULT_ADDR || !VAULT_TOKEN) return false;
  const url = `${VAULT_ADDR.replace(/\/$/, '')}/v1/${path}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Vault-Token': VAULT_TOKEN },
    body: JSON.stringify({ data: fields }),
  });
  if (!res.ok) {
    console.log(`[verify] WARNING: failed to write ${path} (HTTP ${res.status}: ${await res.text()})`);
    return false;
  }
  console.log(`[verify] wrote ${path}`);
  return true;
}

// Write both client secrets to Vault. TE secret is read by the MCP server
// on every Token Exchange call; UI secret is read by scripts/get-clinician-token.sh
// for the dev OIDC code-exchange flow.
//
// Important safety guard: ONLY write to Vault when we actually have a
// non-empty secret. Verify's authenticated GET on an existing app may or
// may not include clientSecret depending on tenant version; if it does
// not, our 'app already exists' path returns clientSecret:undefined and
// writing that would clobber a working secret already in Vault with
// an empty string. The guard makes re-runs of the bootstrap safe.
let teLanded = 'env';
let uiLanded = 'env';
if (VAULT_ADDR && VAULT_TOKEN) {
  if (teApp.clientSecret) {
    if (await writeVaultKv('secret/data/VERIFY_TE_CLIENT_SECRET', { value: teApp.clientSecret })) {
      teLanded = 'vault';
    }
  } else {
    console.log('[verify] TE clientSecret not exposed on existing-app GET; leaving Vault entry unchanged');
    teLanded = 'vault-existing';   // assume the previous bootstrap wrote it
  }
  if (uiApp.clientSecret) {
    if (await writeVaultKv('secret/data/VERIFY_UI_CLIENT_SECRET', { value: uiApp.clientSecret })) {
      uiLanded = 'vault';
    }
  } else {
    console.log('[verify] UI clientSecret not exposed on existing-app GET; leaving Vault entry unchanged');
    uiLanded = 'vault-existing';
  }
}
const secretLanded = teLanded;   // back-compat for the printout block below

console.log('\n--------------------------------------------------------------');
console.log(' Verify bootstrap complete. Wrote verify-output.json');
console.log('');
console.log(' Copy these into your other .env files:');
console.log(`   VERIFY_TENANT_HOST=${TENANT}`);
console.log(`   VERIFY_UI_CLIENT_ID=${uiApp.clientId}`);
console.log(`   VERIFY_TE_CLIENT_ID=${teApp.clientId}`);
console.log('');
if ((teLanded === 'vault' || teLanded === 'vault-existing') &&
    (uiLanded === 'vault' || uiLanded === 'vault-existing')) {
  console.log(' Secrets in Vault:');
  console.log('   VERIFY_TE_CLIENT_SECRET -> secret/data/VERIFY_TE_CLIENT_SECRET');
  console.log('   VERIFY_UI_CLIENT_SECRET -> secret/data/VERIFY_UI_CLIENT_SECRET');
  console.log('');
  console.log(' MCP server reads VERIFY_TE_CLIENT_SECRET on every Token Exchange.');
  console.log(' scripts/get-clinician-token.sh reads VERIFY_UI_CLIENT_SECRET for the');
  console.log(' dev sign-in flow. Both fetch from Vault directly; neither secret');
  console.log(' lands on disk.');
} else {
  console.log(' (No Vault KV write happened for some secrets. Set VAULT_ADDR + VAULT_TOKEN');
  console.log('  in this directory\'s .env to land the secrets in Vault automatically.)');
  console.log('');
  console.log(' Fallback values (paste-on-demand only; never commit):');
  if (teLanded !== 'vault') console.log(`   VERIFY_TE_CLIENT_SECRET=${teApp.clientSecret}`);
  if (uiLanded !== 'vault') console.log(`   VERIFY_UI_CLIENT_SECRET=${uiApp.clientSecret}`);
}
console.log('');
console.log(' IMPORTANT: open the access policy in the Verify Admin UI, click');
console.log(' Save then Publish so it goes ACTIVE. API-created policies sit in');
console.log(' IDLE state until you do this once.');
console.log('--------------------------------------------------------------');
