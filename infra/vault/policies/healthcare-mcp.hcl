# Policy the MCP server's Vault token uses to call the verify-rar plugin
# and to read its own service secrets out of KV.
# Three capabilities are needed:
#   1. update on verify-rar/creds/<role> -- to request a credential per call.
#      (The plugin handler accepts JSON in the request body, which requires
#       the `update` HTTP verb in Vault even though semantically it is a read.)
#   2. update on sys/leases/revoke -- to revoke the lease early when the read
#      finishes, instead of waiting for the 5-minute TTL.
#   3. read on secret/data/VERIFY_TE_CLIENT_SECRET -- the Verify Token Exchange
#      client secret, written to Vault by infra/verify/bootstrap-verify.ts so
#      it does NOT have to live in mcp-server/.env.

path "verify-rar/creds/*" {
  capabilities = ["read", "update"]
}

path "sys/leases/revoke" {
  capabilities = ["update"]
}

path "secret/data/VERIFY_TE_CLIENT_SECRET" {
  capabilities = ["read"]
}
