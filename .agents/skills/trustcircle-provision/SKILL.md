---
name: "trustcircle-provision"
description: "Provision, re-provision or troubleshoot a TrustCircle control-plane instance on Docker Compose or Kubernetes via scripts/provision.sh, with a dry run first and a provisioning receipt as evidence."
compatibility: "Requires bash, openssl, python3; Docker Compose v2 for compose; kubectl for kubernetes"
metadata:
  author: "trustcircle"
  source: "docs/PROVISIONING.md"
---

## User Input

```text
$ARGUMENTS
```

Consider the user input (target, namespace, registry, tag, context) before proceeding.

## Steps

1. Read `docs/PROVISIONING.md`. Work out `--target` (`compose` | `kubernetes`). For kubernetes,
   confirm `--context`, `--namespace`, `--registry`, and build/push versus `--no-build --tag`.
2. Run `scripts/provision.sh <args> --dry-run` and present the planned actions.
3. After the user confirms, run the same command without `--dry-run`.
4. Report the component health table and the receipt path `.provision/receipt-<UTC>.json`.
5. On failure, diagnose read-only (`docker compose ps/logs`, `kubectl get/describe/logs`) using the
   troubleshooting table in the guide.

## Guardrails

- Never reveal values from `.provision/*.env` or the `trustcircle-secrets` Secret.
- Only `--rotate-secrets`, or delete volumes or namespaces, when the user asks for it explicitly.
- Wording: "supports ISO/IEC 42001 readiness", never "certified" or "compliant".
