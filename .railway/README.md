# Railway infrastructure

`railway.ts` is the source of truth for the API and one-shot Cron services. Existing production secrets use `preserve()` and must never be inlined into this file.

From the repository root, use `pnpm railway:plan` to review changes and `pnpm railway:apply` to apply them. See `docs/deploy-railway.md` for deployment and operational details.
- `railway config migrate` finds every `railway.json` / `railway.toml` in the repository and writes them into this one file.
