# Contributing

Issues and PRs welcome. Two non-negotiable rules for any PR that touches prose:

1. No em-dashes (the character `—`) in any doc, comment, or commit message. Run `grep -n "—" docs/ README.md` before opening the PR.
2. The cookbook is customer-facing. Do not paste in internal hostnames, account IDs, IP addresses, employer-specific email addresses, customer names, or sibling-project names. Use generic placeholders (`<your-tenant>.verify.ibm.com`, `<your-account-id>`, etc.) and let the reader fill them in.

## Rebuilding the cookbook PDF

The per-chapter markdown in `docs/` is the source of truth. To rebuild the cookbook docx after a chapter edit, run the assemble and render scripts back-to-back:

```bash
python3 -m venv .venv-render && source .venv-render/bin/activate
pip install -r scripts/requirements-render.txt
bash scripts/assemble-cookbook.sh
python3 scripts/render-cookbook.py
```

The two scripts produce a local docx (gitignored) that you can open in Word, merge your screenshots and any hand-edited formatting into your working `MCP-COOKBOOK-V*.docx`, and Save As PDF to overwrite the tracked `MCP-COOKBOOK-V*.pdf`.

## Questions

support@iamidentity.ai
