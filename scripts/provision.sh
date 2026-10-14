#!/usr/bin/env bash
# scripts/provision.sh — consumer provisioning for the TrustCircle governance control plane.
#
# Stands up the core-only runtime profile (deploy/profiles/components.yaml) on either
#   --target compose     Docker Compose v2 on a single host (evaluation / pilot), or
#   --target kubernetes  any conformant cluster, via the kustomize base in deploy/kubernetes/base.
#
# Properties:
#   * Idempotent: re-running converges; existing secrets in the env file are reused, never rotated
#     silently (pass --rotate-secrets to rotate deliberately).
#   * No secret is printed or committed: secrets live only in the env file (default
#     .provision/<target>.env, git-ignored, mode 0600) and in the target's own secret store.
#   * Fail closed: every preflight failure stops the run before anything is changed.
#   * Evidence: each run writes a provisioning receipt (.provision/receipt-<utc>.json) recording
#     versions, inputs (never secret values), checksums of the applied sources and component
#     health — suitable as ISO/IEC 42001 change/operational-control evidence (Annex A.6).
#
# Usage: scripts/provision.sh --target compose|kubernetes [options]   (see --help)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_DIR="${REPO_ROOT}/.provision"
COMPOSE_FILE="${REPO_ROOT}/deploy/compose/control-plane.yml"
K8S_BASE="${REPO_ROOT}/deploy/kubernetes/base"
APP_TIERS=(api command-worker projector discovery-agent web)

TARGET=""
NAMESPACE="trustcircle"
REGISTRY=""
TAG=""
ENV_FILE=""
BUILD=1
PUSH=0
DRY_RUN=0
ROTATE=0
WAIT_SECONDS=600
KUBE_CONTEXT=""
COMPONENT_STATE="[]"
ENDPOINTS="{}"

usage() {
  cat <<'EOF'
Usage: scripts/provision.sh --target compose|kubernetes [options]

Targets
  --target compose           Docker Compose v2 on this host (ports 14000 web, 14001 api)
  --target kubernetes        Apply deploy/kubernetes/base to the current kube context

Options
  --namespace NAME           Kubernetes namespace (default: trustcircle)
  --context NAME             kubectl context to use (default: current context)
  --registry HOST/PATH       Image registry prefix for kubernetes, e.g. registry.example.com/tc
  --tag TAG                  Image tag (default: short git commit)
  --no-build                 Do not build images (use already-pushed images)
  --push                     Push built images to --registry (kubernetes)
  --env-file PATH            Secrets/env file (default: .provision/<target>.env)
  --rotate-secrets           Generate new secrets even if the env file exists
  --wait SECONDS             Health wait budget (default: 600)
  --dry-run                  Print the actions, change nothing
  -h, --help                 Show this help

Examples
  scripts/provision.sh --target compose
  scripts/provision.sh --target kubernetes --registry registry.example.com/tc --push
  scripts/provision.sh --target kubernetes --no-build --registry registry.example.com/tc --tag v1.2.0
EOF
}

log() { printf '\033[1;34m[provision]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[provision] WARN:\033[0m %s\n' "$*" >&2; }
die() {
  printf '\033[1;31m[provision] ERROR:\033[0m %s\n' "$*" >&2
  exit 1
}
run() {
  if ((DRY_RUN)); then
    printf '  (dry-run) %s\n' "$*"
  else
    "$@"
  fi
}

while (($#)); do
  case "$1" in
    --target) TARGET="${2:?}"; shift 2 ;;
    --namespace) NAMESPACE="${2:?}"; shift 2 ;;
    --context) KUBE_CONTEXT="${2:?}"; shift 2 ;;
    --registry) REGISTRY="${2%/}"; shift 2 ;;
    --tag) TAG="${2:?}"; shift 2 ;;
    --no-build) BUILD=0; shift ;;
    --push) PUSH=1; shift ;;
    --env-file) ENV_FILE="${2:?}"; shift 2 ;;
    --rotate-secrets) ROTATE=1; shift ;;
    --wait) WAIT_SECONDS="${2:?}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; die "unknown argument: $1" ;;
  esac
done

[[ "$TARGET" == compose || "$TARGET" == kubernetes ]] || { usage >&2; die "--target compose|kubernetes is required"; }
[[ "$NAMESPACE" =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ ]] || die "invalid namespace: $NAMESPACE"
ENV_FILE="${ENV_FILE:-${STATE_DIR}/${TARGET}.env}"
TAG="${TAG:-$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo local)}"
KUBECTL=(kubectl)
[[ -n "$KUBE_CONTEXT" ]] && KUBECTL+=(--context "$KUBE_CONTEXT")

# ---------------------------------------------------------------------------
# Preflight — fail closed before changing anything.
# ---------------------------------------------------------------------------
need() { command -v "$1" >/dev/null 2>&1 || die "missing prerequisite: $1 ($2)"; }

preflight() {
  log "preflight (target=${TARGET})"
  need openssl "secret generation"
  need sha256sum "receipt checksums"
  if [[ "$TARGET" == compose ]]; then
    need docker "Docker Engine 24+"
    docker compose version >/dev/null 2>&1 || die "Docker Compose v2 plugin is required"
    docker info >/dev/null 2>&1 || die "Docker daemon is not reachable"
    local mem_kb
    mem_kb=$(awk '/MemTotal/ {print $2}' /proc/meminfo 2>/dev/null || echo 0)
    ((mem_kb >= 8 * 1024 * 1024)) || warn "less than 8 GiB RAM detected; the full core profile may not fit"
    for port in 14000 14001; do
      if (ss -ltn 2>/dev/null || true) | awk '{print $4}' | grep -qE "[:.]${port}\$"; then
        docker ps --format '{{.Ports}}' | grep -q "${port}->" ||
          die "port ${port} is in use by a non-trustcircle process"
      fi
    done
  else
    need kubectl "Kubernetes CLI 1.27+"
    "${KUBECTL[@]}" version --request-timeout=10s >/dev/null 2>&1 || die "cluster unreachable with the selected kube context"
    "${KUBECTL[@]}" auth can-i create deployments -n "$NAMESPACE" >/dev/null 2>&1 ||
      "${KUBECTL[@]}" auth can-i create namespaces >/dev/null 2>&1 ||
      die "current identity cannot create deployments in namespace ${NAMESPACE}"
    if ((BUILD)) || ((PUSH)); then need docker "image build"; fi
    if ((PUSH)) && [[ -z "$REGISTRY" ]]; then die "--push requires --registry"; fi
    [[ -n "$REGISTRY" ]] || warn "no --registry given: images stay trustcircle/<tier>:${TAG} and must be loadable by the cluster (kind/minikube)"
  fi
}

# ---------------------------------------------------------------------------
# Secrets — generated once per consumer, stored only in the 0600 env file.
# ---------------------------------------------------------------------------
gen_secret() { openssl rand -base64 36 | tr -d '/+=\n' | cut -c1-32; }

ensure_env_file() {
  mkdir -p "$(dirname "$ENV_FILE")"
  if [[ -s "$ENV_FILE" && $ROTATE -eq 0 ]]; then
    log "reusing existing secrets in ${ENV_FILE#"$REPO_ROOT"/}"
  else
    ((ROTATE)) && warn "rotating secrets: existing data volumes keep the OLD postgres password; rotate inside the database too"
    log "generating new secrets into ${ENV_FILE#"$REPO_ROOT"/}"
    if ((DRY_RUN)); then
      # Placeholder values so the dry run can render every manifest; nothing is persisted.
      ENV_FILE=$(mktemp)
      trap 'rm -f "$ENV_FILE"' EXIT
      printf 'POSTGRES_PASSWORD=dry-run\nOBJECT_STORE_SECRET_KEY=dry-run\nDATABASE_URL=postgres://trustcircle:dry-run@postgres:5432/trustcircle\n' >"$ENV_FILE"
      return
    fi
    local pg obj
    pg=$(gen_secret)
    obj=$(gen_secret)
    umask 077
    cat >"$ENV_FILE" <<EOF
# Generated by scripts/provision.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ). Keep private; never commit.
POSTGRES_PASSWORD=${pg}
OBJECT_STORE_SECRET_KEY=${obj}
DATABASE_URL=postgres://trustcircle:${pg}@postgres:5432/trustcircle
EOF
  fi
  chmod 600 "$ENV_FILE" 2>/dev/null || true
  if [[ -s "$ENV_FILE" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "$ENV_FILE"
    set +a
  fi
}

# ---------------------------------------------------------------------------
# Images.
# ---------------------------------------------------------------------------
image_ref() { if [[ -n "$REGISTRY" ]]; then echo "${REGISTRY}/$1:${TAG}"; else echo "trustcircle/$1:${TAG}"; fi; }

build_images() {
  ((BUILD)) || { log "skipping image build (--no-build)"; return; }
  for tier in "${APP_TIERS[@]}"; do
    log "building $(image_ref "$tier")"
    run docker build -q -f "${REPO_ROOT}/deploy/compose/Dockerfile" --target "$tier" -t "$(image_ref "$tier")" "$REPO_ROOT"
    if ((PUSH)); then run docker push "$(image_ref "$tier")"; fi
  done
}

# ---------------------------------------------------------------------------
# Compose target.
# ---------------------------------------------------------------------------
compose_override() {
  local override="${STATE_DIR}/compose.override.yml"
  # Overrides only the local-dev credential placeholders of control-plane.yml with the consumer's
  # generated secrets, referenced by name so no value is written to this file.
  ((DRY_RUN)) && { echo "$override"; return; }
  cat >"$override" <<'EOF'
# Generated by scripts/provision.sh — credential overrides for deploy/compose/control-plane.yml.
x-secret-env: &secret-env
  DATABASE_URL: ${DATABASE_URL:?}
  OBJECT_STORE_SECRET_KEY: ${OBJECT_STORE_SECRET_KEY:?}
services:
  postgres:
    environment:
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?}
  object-storage:
    environment:
      MINIO_ROOT_PASSWORD: ${OBJECT_STORE_SECRET_KEY:?}
  api: { environment: *secret-env }
  command-worker: { environment: *secret-env }
  projector: { environment: *secret-env }
  discovery-agent: { environment: *secret-env }
  web: { environment: *secret-env }
EOF
  echo "$override"
}

provision_compose() {
  local override
  override=$(compose_override)
  local dc=(docker compose -f "$COMPOSE_FILE" -f "$override" --env-file "$ENV_FILE")
  if [[ -s "$ENV_FILE" ]] && ! ((DRY_RUN)); then
    "${dc[@]}" config -q || die "compose configuration does not validate"
  fi
  if ((BUILD)); then
    run "${dc[@]}" up -d --build --wait --wait-timeout "$WAIT_SECONDS"
  else
    run "${dc[@]}" up -d --no-build --wait --wait-timeout "$WAIT_SECONDS"
  fi
  ((DRY_RUN)) || "${dc[@]}" ps --format 'table {{.Service}}\t{{.State}}\t{{.Health}}'
  COMPONENT_STATE=$( ((DRY_RUN)) && echo '[]' || "${dc[@]}" ps --format json | python3 -c '
import json,sys
rows=[json.loads(l) for l in sys.stdin if l.strip()]
rows=rows[0] if len(rows)==1 and isinstance(rows[0],list) else rows
print(json.dumps([{"component":r.get("Service"),"state":r.get("State"),"health":r.get("Health")} for r in rows]))')
  ENDPOINTS='{"web":"http://localhost:14000","api":"http://localhost:14001"}'
}

# ---------------------------------------------------------------------------
# Kubernetes target.
# ---------------------------------------------------------------------------
kapply_stdin() { if ((DRY_RUN)); then cat >/dev/null; printf '  (dry-run) kubectl apply %s\n' "$*"; else "${KUBECTL[@]}" apply "$@" -f -; fi; }

provision_kubernetes() {
  local ns=(-n "$NAMESPACE")
  log "namespace ${NAMESPACE}"
  "${KUBECTL[@]}" create namespace "$NAMESPACE" --dry-run=client -o yaml | kapply_stdin
  log "secret trustcircle-secrets (values from env file, not printed)"
  "${KUBECTL[@]}" "${ns[@]}" create secret generic trustcircle-secrets --from-env-file="$ENV_FILE" --dry-run=client -o yaml | kapply_stdin "${ns[@]}"
  log "config maps (migrations, otel, nats topology)"
  "${KUBECTL[@]}" "${ns[@]}" create configmap trustcircle-migrations --from-file="${REPO_ROOT}/db/migrations" --dry-run=client -o yaml | kapply_stdin "${ns[@]}"
  "${KUBECTL[@]}" "${ns[@]}" create configmap trustcircle-otel --from-file="${REPO_ROOT}/deploy/compose/otel-collector.yaml" --dry-run=client -o yaml | kapply_stdin "${ns[@]}"
  "${KUBECTL[@]}" "${ns[@]}" create configmap trustcircle-nats-topology --from-file=topology.json="${REPO_ROOT}/deploy/nats/topology.json" --dry-run=client -o yaml | kapply_stdin "${ns[@]}"

  local overlay="${STATE_DIR}/kubernetes"
  mkdir -p "$overlay"
  local rel
  rel=$(python3 -c 'import os,sys;print(os.path.relpath(sys.argv[1],sys.argv[2]))' "$K8S_BASE" "$overlay")
  {
    echo "# Generated by scripts/provision.sh — consumer overlay; do not commit."
    echo "apiVersion: kustomize.config.k8s.io/v1beta1"
    echo "kind: Kustomization"
    echo "namespace: ${NAMESPACE}"
    echo "resources: [${rel}]"
    echo "images:"
    for tier in "${APP_TIERS[@]}"; do
      local ref name
      ref=$(image_ref "$tier")
      name="${ref%:*}"
      echo "  - { name: trustcircle/${tier}, newName: ${name}, newTag: '${TAG}' }"
    done
  } >"${overlay}/kustomization.yaml"
  log "applying deploy/kubernetes/base via ${overlay#"$REPO_ROOT"/}"
  if ((DRY_RUN)); then
    "${KUBECTL[@]}" kustomize "$overlay" >/dev/null && echo "  (dry-run) kubectl apply -k ${overlay}"
  else
    "${KUBECTL[@]}" apply -k "$overlay"
    log "waiting up to ${WAIT_SECONDS}s for rollouts"
    for sts in postgres object-storage nats; do
      "${KUBECTL[@]}" "${ns[@]}" rollout status "statefulset/${sts}" --timeout="${WAIT_SECONDS}s"
    done
    for dep in opa collector "${APP_TIERS[@]}"; do
      "${KUBECTL[@]}" "${ns[@]}" rollout status "deployment/${dep}" --timeout="${WAIT_SECONDS}s"
    done
  fi
  COMPONENT_STATE=$( ((DRY_RUN)) && echo '[]' || "${KUBECTL[@]}" "${ns[@]}" get deploy,sts -l app.kubernetes.io/part-of=trustcircle -o json | python3 -c '
import json,sys
d=json.load(sys.stdin)
print(json.dumps([{"component":i["metadata"]["name"],"kind":i["kind"],"ready":i.get("status",{}).get("readyReplicas",0),"desired":i["spec"].get("replicas",1)} for i in d["items"]]))')
  ENDPOINTS="{\"web\":\"kubectl -n ${NAMESPACE} port-forward svc/web 14000:8080\",\"api\":\"kubectl -n ${NAMESPACE} port-forward svc/api 14001:3000\"}"
}

# ---------------------------------------------------------------------------
# Receipt — audit evidence of what was provisioned (no secret values).
# ---------------------------------------------------------------------------
write_receipt() {
  ((DRY_RUN)) && { log "dry-run complete; no receipt written"; return; }
  local ts receipt sources_hash
  ts=$(date -u +%Y%m%dT%H%M%SZ)
  receipt="${STATE_DIR}/receipt-${ts}.json"
  sources_hash=$(cd "$REPO_ROOT" && find deploy/compose deploy/kubernetes/base deploy/profiles deploy/nats db/migrations -type f -print0 |
    sort -z | xargs -0 sha256sum | sha256sum | cut -d' ' -f1)
  python3 - "$receipt" <<EOF
import json, sys
receipt = {
  "schema": "trustcircle.provisioning-receipt/v1",
  "provisionedAt": "${ts}",
  "target": "${TARGET}",
  "namespace": "${NAMESPACE}" if "${TARGET}" == "kubernetes" else None,
  "gitCommit": "$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || echo unknown)",
  "gitDirty": $( [[ -n "$(git -C "$REPO_ROOT" status --porcelain 2>/dev/null)" ]] && echo True || echo False ),
  "imageTag": "${TAG}",
  "images": [$(for t in "${APP_TIERS[@]}"; do printf '"%s",' "$(image_ref "$t")"; done)],
  "deploySourcesSha256": "${sources_hash}",
  "secretsSource": "env-file (values not recorded)",
  "components": json.loads('''${COMPONENT_STATE}'''),
  "endpoints": json.loads('''${ENDPOINTS}'''),
  "operator": "$(id -un 2>/dev/null || echo unknown)",
  "claimBoundary": "Provisioning evidence only. It does not certify ISO/IEC 42001 conformance.",
}
json.dump(receipt, open(sys.argv[1], "w"), indent=2)
EOF
  log "receipt: ${receipt#"$REPO_ROOT"/}"
}

main() {
  preflight
  mkdir -p "$STATE_DIR"
  ensure_env_file
  if [[ "$TARGET" == kubernetes ]]; then build_images; provision_kubernetes; else provision_compose; fi
  write_receipt
  log "done. Web UI: $(python3 -c 'import json,sys;print(json.loads(sys.argv[1]).get("web","n/a"))' "$ENDPOINTS")"
  log "the preview runs with LOCAL_OPERATOR_PREVIEW (read-only auditor principal) until an identity gateway is configured; see docs/PROVISIONING.md"
}

main "$@"
