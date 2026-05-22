# Vault plugin directory

This directory is mounted into the Vault dev container at `/vault/plugins` (read-only). Drop the compiled `vault-plugin-secrets-verify-rar` binary here so Vault can register it.

## Where the plugin comes from

The verify-rar Vault plugin's public source repository is in the process of being published. Until that lands, request the compiled binary (or the source archive for an audit) by emailing **support@iamidentity.ai**. State the OS and CPU architecture of the Vault container you intend to run it in. The reply ships back a binary named `vault-plugin-secrets-verify-rar` plus a SHA-256 checksum.

## Installing the binary (one-time)

```bash
# Drop the binary into this cookbook's plugin directory
cp ~/Downloads/vault-plugin-secrets-verify-rar \
   <path-to-this-repo>/infra/vault/plugins/vault-plugin-secrets-verify-rar
chmod +x <path-to-this-repo>/infra/vault/plugins/vault-plugin-secrets-verify-rar

# Verify the SHA-256 matches the one support@iamidentity.ai sent
shasum -a 256 <path-to-this-repo>/infra/vault/plugins/vault-plugin-secrets-verify-rar
```

After the binary is in place, the next `docker compose up vault` will see it under `/vault/plugins/` inside the container. The bootstrap script in `infra/vault/bootstrap-vault.sh` registers it with the running Vault (it computes the SHA itself before registering — you do not need to pass it in).

## Building from source (advanced)

Once you receive the source archive, the build is a standard Go build:

```bash
cd verify-rar-vault-plugin
go mod tidy   # refresh against your local Go toolchain if it is newer than go.mod
make build    # produces bin/vault-plugin-secrets-verify-rar for your local arch
```

For a Linux container target from a Mac developer machine: `GOOS=linux GOARCH=arm64 make build` (Apple Silicon → linux/arm64) or `GOOS=linux GOARCH=amd64 make build` (Intel Mac → linux/amd64). The binary has to match the Vault container's architecture, not the build host's.

## A sibling plugin you do NOT need for this cookbook

There is a separate companion plugin that automates IBM Verify client-secret rotation out of Vault. It is useful in production but is not required for the cookbook's flow. You can ignore it for now; the cookbook uses a 24-hour static Vault token for the MCP server instead.

## Why the binary is not checked in

Compiled binaries are architecture-specific (darwin-arm64, linux-amd64, etc.) and they belong to whoever builds them. Each developer brings their own binary for their target. The plugin directory is gitignored except for this README and a placeholder.
