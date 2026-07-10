#!/usr/bin/env bash
# Shared settings for deploy scripts. Override via env:
#   VM_NAME=my-bot GCP_ZONE=us-central1-a ./01-create-vm.sh
set -euo pipefail

VM_NAME="${VM_NAME:-coding-bot}"

GCP_PROJECT="${GCP_PROJECT:-$(gcloud config get-value project 2>/dev/null || true)}"
if [[ -z "$GCP_PROJECT" || "$GCP_PROJECT" == "(unset)" ]]; then
  echo "Не задан GCP-проект: export GCP_PROJECT=... или gcloud config set project ..." >&2
  exit 1
fi

GCP_ZONE="${GCP_ZONE:-$(gcloud config get-value compute/zone 2>/dev/null || true)}"
if [[ -z "$GCP_ZONE" || "$GCP_ZONE" == "(unset)" ]]; then
  GCP_ZONE="europe-west1-b"
fi

GC() {
  gcloud --project "$GCP_PROJECT" "$@"
}

VSSH() {
  # VSSH [--] remote command...
  GC compute ssh "$VM_NAME" --zone "$GCP_ZONE" -- "$@"
}

echo "== project=$GCP_PROJECT zone=$GCP_ZONE vm=$VM_NAME" >&2
