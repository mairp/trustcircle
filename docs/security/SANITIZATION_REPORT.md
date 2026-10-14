# Repository sanitisation report

Date: 2026-10-14 · Scope: full working tree and full git history of this repository (all branches
and tags; 112 commits at the time of the review).

This report records how the repository was checked for sensitive information before being shared
with consumers. It deliberately reproduces none of the removed values.

## Method

| Step                   | Tool                                                                                                                                                                        | Coverage                                                            |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Secret scan            | gitleaks 8.30.1, default ruleset plus `.gitleaks.toml`                                                                                                                      | every commit (`gitleaks git`) and the working tree (`gitleaks dir`) |
| Identity and host scan | `git grep` across every commit for home-directory paths, user names, e-mail addresses, IPv4 addresses, hostnames, VPN/overlay domains, hypervisor names and kube namespaces | every commit                                                        |
| Infrastructure review  | manual review of `deploy/`, `.github/workflows/`, compose/Kubernetes files and runbooks                                                                                     | working tree                                                        |
| History rewrite        | `git filter-repo --replace-text` (file contents) and `--replace-message` (commit messages)                                                                                  | every commit                                                        |

## Findings and disposition

| #   | Category                  | Finding                                                                                                                                                                        | Classification              | Disposition                                                                                                                                                                                                           |
| --- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | Personal path / user name | Absolute home-directory paths naming a personal account appeared in about 1,700 lines across 50+ files: specs, execution packets, test plan, bootstrap guide and test evidence | **Real**                    | Replaced throughout history with `<repo-root>` / `<workspace>`; zero occurrences remain                                                                                                                               |
| F2  | Organisation identifier   | An organisation-specific infrastructure name was part of a Terraform classifier ID and its descriptions                                                                        | **Real**                    | Replaced throughout history. The classifier is now the generic `terraform`, with aliases `tf` and `terraform-iac`                                                                                                     |
| F3  | Credentials               | 18 gitleaks matches                                                                                                                                                            | **Synthetic**               | All are test fixtures or prose: the public jwt.io sample token, idempotency and correlation keys, and two documentation sentences. Allowlisted narrowly by regex and path in `.gitleaks.toml`, with a reason for each |
| F4  | Private IPs               | `10.x.x.x` addresses in accessibility test models                                                                                                                              | **Synthetic**               | Fictional `vpc-*` fixture locations. Kept                                                                                                                                                                             |
| F5  | IP-like strings           | Dotted numbers in code comments                                                                                                                                                | **False positive**          | RFC and OIDC section numbers. Kept                                                                                                                                                                                    |
| F6  | Namespace                 | Hard-coded namespace in the Kubernetes recovery runbook                                                                                                                        | **Contextual**              | Replaced with a `$NAMESPACE` parameter                                                                                                                                                                                |
| F7  | Local-dev credentials     | Placeholder passwords in `deploy/compose/control-plane.yml`                                                                                                                    | **Documented placeholders** | Kept for local development. `scripts/provision.sh` overrides them with per-instance random secrets that are never committed                                                                                           |
| F8  | Stray files               | Tracked `*.orig` merge leftovers                                                                                                                                               | Hygiene                     | Removed                                                                                                                                                                                                               |
| F9  | Commit identity           | The commit author identity is the repository owner's chosen public identity                                                                                                    | **Accepted**                | Kept, at the owner's request                                                                                                                                                                                          |

Product vocabulary that names classes of external systems in the discovery classifiers (for example
agent frameworks, NetBox and gNMI) is functional, carries no host or credential, and was kept.

## Result

- `gitleaks git . --config .gitleaks.toml`: no leaks found.
- `gitleaks dir . --config .gitleaks.toml`: no leaks found.
- No personal paths, organisation identifiers, private hostnames, real IP addresses or credentials
  remain in the working tree or the history.

## Keeping it clean

- CI job `secret-scan (gitleaks)` in `.github/workflows/verify.yml` scans the full history on
  every push and pull request, and is part of `verify (required)`.
- Consumer secrets are generated into `.provision/` (git-ignored, mode 0600) and never into
  tracked files.
- Any new allowlist entry must be a narrow regex plus path, with a reason, added to
  `.gitleaks.toml` and recorded here.

## Residual risk

- **Old copies outside this repository.** Clones, forks, CI caches or GitHub's cached views of
  pull requests taken before the rewrite can still contain the old history. Collaborators must
  re-clone. GitHub support can purge cached views if needed.
- **Hashes cited in old documents.** Commit hashes changed with the rewrite, so a commit ID quoted
  in an external document from before 2026-10-14 no longer resolves.
