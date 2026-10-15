# Security

## Reporting a vulnerability

Please report security problems privately, through GitHub's
[private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
on this repository (the **Security** tab → **Report a vulnerability**), not in a public issue.
Include what you found, how to reproduce it, and what an attacker could do with it. You'll get a
reply within a week.

## Scope

In scope: the server (`src/`), the web client (`web/`), published sites (`/p/…`), the MCP
endpoint, and the deployment files in this repository (`Dockerfile`, `render.yaml`,
`.github/workflows/`).

Out of scope: a deployment's own configuration (a weak `SETUP_TOKEN`, signup left open, no
HTTPS), and problems in third-party AI providers or GitHub.

## How the app is meant to be secure

[docs/ARCHITECTURE.md §8](docs/ARCHITECTURE.md#8-security-model) describes the security model:
sessions, same-origin checks, roles, bearer tokens, encrypted secrets, the published-site
sandbox and the SSRF guard. A report that shows one of those guarantees failing is especially
welcome.
