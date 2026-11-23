# Contributing

Issues and pull requests are welcome on this repository. This is a personal, unofficial project; Sophos support can't help with it.

## Rules for changes

- Read only. The exporter never writes to a Sophos tenant. A new read goes through `src/sophos/guard.ts`: a new REST path joins `ALLOWED_GET_PATHS`, and a new GraphQL query is added to `src/sophos/documents.ts`, where the guard and the tests pick it up.
- Documented APIs only. A query must validate against the published schema in `schemas/fusion`, which `test/documents.test.mjs` checks.
- Schema changes add columns at the end of a table, bump the table's minor version, and come with `npm run docs`, the regenerated templates (`node scripts/build-grafana.mjs`, `node scripts/build-powerbi.mjs`) and the golden files (`UPDATE_GOLDEN=1 node --test test/run.test.mjs`).
- A model change also needs both `.pbit` templates exported again on Windows (open the `.pbip` in Power BI Desktop, File > Export > Power BI template, then remove `SecurityBindings` as the README says). `npm run check:pbit` lists any template that has drifted from its PBIP project.
- Never commit real tenant data. Test fixtures and `demo/` are synthetic; build new fixtures by hand or from `scripts/make-demo.mjs`.
- No secrets in code, config, fixtures, logs or output.

## Checks

```sh
npm ci
npm run typecheck
npm test
```

CI runs the same on Ubuntu, macOS and Windows with Node.js 22 and 24, and fails if the generated templates or docs are out of date. It also lints the Azure template and checks `deploy/azure/azuredeploy.json` matches `main.bicep` (Bicep 0.49.2: run `bicep build deploy/azure/main.bicep --outfile deploy/azure/azuredeploy.json` after a change), builds the container image, and runs `scripts/check-output-folder.mjs` in it against an SMB share.

Write commit messages in the conventional style, for example `fix(cases): ...`.
