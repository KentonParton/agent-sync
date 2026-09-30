# Maintainer security

Publishing source does not require giving contributors account credentials. The main supply-chain risk is executing untrusted code where it can read credentials or exercise publishing permissions.

## Repository controls

- CI uses GitHub-hosted runners with a read-only `GITHUB_TOKEN`, no publishing permission, and no configured secret inputs.
- Checkout does not persist its Git credential for subsequent build and test commands.
- GitHub Actions are pinned to full commit SHAs. npm dependencies use the committed lockfile and `npm ci --ignore-scripts`.
- The local `.npmrc` disables automatic lifecycle scripts, including install and prepack hooks. Build explicitly before packaging. Explicit build/test commands and imported dependencies can still execute code.
- CI does not restore or save dependency caches. It uses `pull_request`, never a privileged `pull_request_target` job that executes contributed code.
- Dependabot proposes weekly npm and Action updates with a seven-day cooldown for version updates. Updates require review; there is no automatic merge. A cooldown gives time for detection but is not a malware guarantee.

## Account and release controls

Use a passkey or hardware security key for GitHub and npm, keep recovery codes offline, and review authorized applications, tokens, SSH keys, and active sessions. Prefer narrowly scoped, expiring credentials. Two-factor authentication does not stop a stolen token or an already authorized process from using its permissions.

Run unfamiliar projects in an isolated environment without your SSH agent, home directory, GitHub credentials, npm configuration, or cloud credentials mounted into it. Disabling install scripts reduces one entry point; it does not make arbitrary builds or tests safe.

Protect the default branch with required CI and pull-request review appropriate to the maintainer team. Repository rules are separate GitHub settings; these source files do not enable them. Keep secret scanning and push protection enabled.

There is currently no npm publishing workflow. Before adding one, configure npm trusted publishing with OIDC for the exact repository, workflow, and protected release environment. Keep `id-token: write` confined to the publishing job, require release approval, and keep untrusted build code away from that job. OIDC avoids a stored npm publishing token but cannot make a compromised authorized publishing job safe.

If you suspect malicious code ran with credentials available, use a clean device to revoke affected credentials and review account activity. Investigate the affected machine before issuing replacement credentials to it. A clean secret scan or `npm audit` result alone does not establish that a machine or dependency is free of malware.

## References

- [GitHub Actions security guidance](https://docs.github.com/en/actions/reference/security/secure-use)
- [GitHub passkeys](https://docs.github.com/en/authentication/authenticating-with-a-passkey/about-passkeys)
- [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/)
- [npm script configuration](https://docs.npmjs.com/cli/v11/using-npm/config/#ignore-scripts)
