# Security

Report a vulnerability privately through GitHub's private vulnerability reporting on this repository, not in a public issue. Please include the version, what you found and how to reproduce it.

This is a personal, unofficial project. Sophos does not support it and its security team does not handle reports about it.

## What the exporter protects

- It only reads from Sophos. The guard in `src/sophos/guard.ts` refuses any request that isn't a GET on a known path, the token request, or one of the exporter's own GraphQL queries, before the request leaves the process. Redirects are refused.
- Credentials come from the environment or an env file. The config file is refused if it holds a secret, and secrets never reach the output folder, `_state/` or the logs.
- The CSV server for Grafana serves only the table files and `_schema.json`, on 127.0.0.1 by default.
- The SharePoint upload talks only to Microsoft Entra, Microsoft Graph and SharePoint, and works with the `Sites.Selected` permission on one site.
- In Azure (`docs/azure.md`), the exporter reads the Sophos credential from Key Vault and signs in to Microsoft Graph with the job's managed identity. It sends the managed identity request only to the local identity endpoint, and the image runs as an unprivileged user.

## What you need to protect

- The machine that runs the exporter and its env file: they hold the Sophos client secret. In Azure, the Key Vault and the rights to change or start the jobs, which can read it.
- The output folder and wherever it is uploaded. With the personal data switch off the files hold no hostnames, users or free text, but they still describe your security posture.
- The direct Power BI path stores the Sophos client secret inside the Power BI file and the published model. Treat any copy as the credential itself.
