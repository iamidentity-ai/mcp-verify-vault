/**
 * MCP server -- mcp-verify-vault
 *
 * Two transports over one shared dispatchTool:
 *   POST /tool  -> simple REST { name, arguments } -> JSON, useful for curl-based debugging
 *   POST /mcp   -> real MCP-protocol Streamable HTTP, what the AgentCore agent connects to
 *
 * On every tool call the bearer in Authorization is the RFC 8693 subject_token.
 * Token Exchange (with a healthcare-flavored RAR) issues an OBO. The OBO is
 * presented directly to Vault as the X-Vault-Token; Vault's OAuth-RS profile
 * validates it against the Verify JWKS, the verify-rar plugin matches the RAR
 * against the role's rar_mappings, and Vault mints a 5-minute Postgres role.
 * The MCP server connects as that ephemeral role, runs the SQL, and revokes
 * the lease.
 */

import 'dotenv/config';
import express, { type Request, type Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { getPatientRecord } from './tools/get-patient-record.js';
import { listPatientsForClinician } from './tools/list-patients-for-clinician.js';
import { exchangeToken } from './verify/token-exchange.js';
import { mintCred, revokeLease } from './vault/verify-rar-client.js';
import { runAsEphemeralRole } from './db/pool.js';

const PORT = Number(process.env.PORT ?? 3012);
const SERVICE = 'vva-mcp-server';

const app = express();
app.use(express.json({ limit: '1mb' }));

app.get('/healthz', (_req: Request, res: Response) => {
  res.json({ status: 'ok', service: SERVICE });
});

// ── Shared dispatcher both transports call ───────────────────────────────────
async function dispatchTool(toolName: string, args: Record<string, unknown>, bearer: string) {
  const claims = { access_token: bearer };
  let trackedLeaseId: string | undefined;

  const trackingMintCred = async (mc: { rarType: string; rarAction: string; patientMrn?: string }) => {
    const cred = await mintCred({ ...mc, claims, exchangeToken });
    trackedLeaseId = cred.leaseId;
    return cred;
  };

  try {
    switch (toolName) {
      case 'get_patient_record':
        return await getPatientRecord({
          mrn: args['mrn'] as string,
          claims,
          mintCred: trackingMintCred,
          runAsEphemeralRole,
          exchangeToken,
        });
      case 'list_patients_for_clinician':
        return await listPatientsForClinician({
          clinicianUpn: (args['clinicianUpn'] as string) || 'ccarter@acmehealth.example',
          claims,
          mintCred: trackingMintCred,
          runAsEphemeralRole,
          exchangeToken,
        });
      default: {
        const err = new Error(`unknown_tool: ${toolName}`);
        (err as Error & { code?: string }).code = 'unknown_tool';
        throw err;
      }
    }
  } finally {
    if (trackedLeaseId) {
      try { await revokeLease(trackedLeaseId); }
      catch (e) { console.warn(`[${SERVICE}] best-effort lease revoke failed:`, (e as Error).message); }
    }
  }
}

// ── Transport 1: POST /tool (simple REST) ────────────────────────────────────
app.post('/tool', async (req: Request, res: Response) => {
  const body = req.body as Record<string, unknown> ?? {};
  const toolName: string | undefined = (body['toolName'] ?? body['name']) as string | undefined;
  const args: Record<string, unknown> = (body['args'] ?? body['arguments'] ?? {}) as Record<string, unknown>;
  const bearer = (req.header('authorization') || '').replace(/^Bearer /, '');
  if (!bearer) return res.status(401).json({ error: 'missing_bearer' });
  try {
    const result = await dispatchTool(toolName!, args, bearer);
    res.json(result);
  } catch (err) {
    const e = err as Error & { code?: string };
    if (e.code === 'unknown_tool') return res.status(400).json({ error: 'unknown_tool', toolName });
    res.status(500).json({ error: 'tool_error', message: e.message });
  }
});

// ── Transport 2: POST /mcp (MCP protocol over Streamable HTTP) ───────────────
function buildMcpServer(bearer: string): McpServer {
  const server = new McpServer({ name: SERVICE, version: '0.1.0' });

  server.registerTool(
    'get_patient_record',
    {
      title: 'Read a patient chart by MRN',
      description: 'Reads a patient chart. VIP patients trigger step-up MFA via the Verify policy.',
      inputSchema: { mrn: z.string() },
    },
    async ({ mrn }) => {
      const r = await dispatchTool('get_patient_record', { mrn }, bearer);
      return { content: [{ type: 'text' as const, text: JSON.stringify(r) }] };
    },
  );

  server.registerTool(
    'list_patients_for_clinician',
    {
      title: "List the clinician's active patient panel",
      description: "Returns mrn, display_name, dob, primary_diagnosis, vip_flag for every patient on the clinician's panel.",
      inputSchema: { clinicianUpn: z.string().optional() },
    },
    async ({ clinicianUpn }) => {
      const r = await dispatchTool('list_patients_for_clinician', { clinicianUpn }, bearer);
      return { content: [{ type: 'text' as const, text: JSON.stringify(r) }] };
    },
  );

  return server;
}

app.post('/mcp', async (req: Request, res: Response) => {
  const bearer = (req.header('authorization') || '').replace(/^Bearer /, '');
  if (!bearer) return res.status(401).json({ error: 'missing_bearer' });

  const server = buildMcpServer(bearer);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => { transport.close(); server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`[${SERVICE}] listening on http://127.0.0.1:${PORT}`);
});
