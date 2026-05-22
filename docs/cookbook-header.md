# Securing Your MCP Server End-to-End: IBM Verify + HashiCorp Vault

A 30-minute hands-on walkthrough that lands a working MCP server on your laptop where every tool call is authorized by IBM Verify policy (with step-up MFA where the policy demands it) and runs under a 5-minute PostgreSQL credential that HashiCorp Vault mints fresh per call. No AWS account required.

## Table of contents

1. Architecture
2. The identity chain
3. Prerequisites
4. Clone the repo
5. Configure IBM Verify
6. Configure HashiCorp Vault
7. Configure PostgreSQL
8. Start the MCP server
9. Run the agent
10. End-to-end smoke test
11. Swapping the LLM
12. Anatomy of an MCP call
13. Troubleshooting
14. Logging for an enterprise SIEM
