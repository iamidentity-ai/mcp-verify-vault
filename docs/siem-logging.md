## Auditing and Logging

Every tool call leaves audit records in five different places. Each is a standard log surface your SIEM already knows how to ingest, and all five entries for the same call share a single `jti` claim from the on-behalf-of token. A SOC analyst can pull one chain end-to-end from any of the five surfaces and replay every step. This chapter is the table that says which is which, and the section that explains the join.

## The five log surfaces

| Surface | What it captures | Forward to your SIEM via |
|---|---|---|
| **Agent process log** | Per-invocation request id, prompt, the tool calls Strands decided to make, duration, any errors. Streamed to stdout/stderr by uvicorn. | Tail to syslog and forward via your standard agent (Splunk Universal Forwarder, Sentinel Log Analytics agent, QRadar WinCollect, Chronicle Forwarder). Or wrap the process in `systemd-cat` / `logger` to land it in `journald`. |
| **MCP server log** | The OBO `jti`, the RAR shape that went to Vault, the lease id Vault returned, the duration of each step. | Same syslog forwarder pattern as the agent log. |
| **HashiCorp Vault audit log** | Every Vault operation: the OBO submission, the `cred_issued` event from the verify-rar plugin, the lease revoke. The plugin extracts the OBO `jti` into the audit record. | Vault's audit device writes to a JSON file or syslog; both are standard SIEM sources. Enable with `vault audit enable file file_path=/vault/audit.log`. |
| **PostgreSQL session log** | Every SQL statement, with the ephemeral role name (`v-healthcare-...`) and the connection start and end. | Postgres `log_destination = stderr` to file, then the same syslog forwarder. The MCP server sets `application_name` on the connection to include the OBO `jti`, so every PG log line for the call carries the join key. |
| **IBM Verify event stream and CAEP** | Every Verify policy evaluation, MFA challenge issued, MFA approved or denied, OBO issued. Each event carries `requestid` (= `grant_id`) and the user principal. | IBM Verify's CAEP transmitter pushes Security Event Tokens (SETs) to any subscriber that speaks OpenID SSF. Subscribe your SIEM as a receiver. |

If you already aggregate Linux and database logs into a SIEM, you already ingest four of these five. The fifth (IBM Verify) speaks the standards your SOC is moving toward anyway (OpenID Shared Signals Framework and Continuous Access Evaluation Profile).

## The `jti` is the join key

This is the headline of the chapter. The OBO JWT minted by IBM Verify carries a unique `jti` (JWT id) claim. That same `jti` appears in:

1.  **IBM Verify's event stream.** Verify emits a `verify:risk` event when the policy evaluates and an `agent:obo_issued` event when the OBO is minted. Both carry the OBO `jti` as a field.
2.  **The Vault audit entry for the credential mint.** The verify-rar plugin extracts the `jti` from the OBO it received and writes it into the audit record's `request.data.jti` field (and into the response's `data.jti`).
3.  **The verify-rar plugin's `cred_issued` event.** A separate higher-level event the plugin emits alongside the audit entry, joinable to the same `jti`.
4.  **The Vault audit entry for the lease revoke.** The plugin attaches the original `jti` to the revoke metadata.
5.  **The MCP server log.** Every log line in the tool call's flow carries the `jti` in its structured payload.
6.  **The PostgreSQL session log.** The MCP server sets `application_name` on the connection string to include the `jti` prefix, so every PostgreSQL log line for that connection carries it.

One SIEM query joins on `jti` and reconstructs the full chain. Splunk: `index=* jti="<value>" | sort _time`. Sentinel KQL: `union * | where Properties contains "<jti>" | order by TimeGenerated`. Same for any other SIEM that does field extraction on JSON or syslog. No correlation engine is required because the correlation id is already in every record.

## What the customer does NOT have to build

The conventional answer to "I want to audit an AI agent" is to build a separate telemetry pipeline: an agent-event aggregator, a custom correlation engine, a bespoke parser for whatever the agent framework emits. None of that is necessary here. The reasons:

*   **No aggregator.** The five surfaces above already exist on systems your operations team manages. No new daemon to run.
*   **No correlation engine.** The `jti` is the correlation id. Your SIEM's existing query engine is the correlation engine.
*   **No bespoke parser.** Vault audit is JSON. PostgreSQL log is the standard `log_line_prefix` plus statement. CAEP SETs are standard JWS. Every SIEM ships parsers for all three.
*   **No agent telemetry pipeline.** The agent itself does not need to emit custom telemetry. The audit trail is produced by the systems the agent talked to, not by the agent.

## Standards-based, not proprietary

Every audit surface in this stack speaks an open standard. There is no proprietary protocol you have to learn or implement support for. The list:

*   **RFC 8693** OAuth 2.0 Token Exchange (the protocol Verify and the MCP server speak for OBO).
*   **RFC 9396** OAuth 2.0 Rich Authorization Requests (the structure of the `authorization_details` block that survives end-to-end).
*   **OpenID Shared Signals Framework (SSF).** The IBM Verify event stream conforms to SSF.
*   **OpenID Continuous Access Evaluation Profile (CAEP).** Security Event Token (SET) format the transmitter emits.
*   **Vault audit JSON.** A documented HashiCorp schema.
*   **PostgreSQL log_line_prefix.** Standard, configurable, and the same for every SIEM that has ever ingested PostgreSQL logs.
*   **syslog / journald.** The two standard Linux log delivery mechanisms; every SIEM has native ingestion.

If your enterprise architecture review asks for "no proprietary audit pipelines," this stack passes by construction.

## What you just did

You read the five log surfaces, you saw the join key that ties them together (`jti`), and you confirmed that every surface in the chain speaks an open standard your SIEM already ingests.

## What's next

You have reached the end of the cookbook. The working chain you have on your laptop is the same chain you would run anywhere else, with the agent and MCP server running on whatever hosting your customer chooses (a container platform, a small VM, a developer laptop) and your existing SIEM in place of the local log tails. Nothing about the security model changes when you move from a laptop to production.

If anything in the chain is misbehaving, [Troubleshooting](./troubleshooting.md) covers the most common gotchas with diagnosis-first prose. If you want a code-level walkthrough of how the MCP server enforces the security chain, the [Anatomy of an MCP Call](./mcp-anatomy.md) chapter quotes the load-bearing files verbatim.
