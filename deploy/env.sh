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

# Free tier: e2-micro доступен бесплатно только в us-west1 / us-central1 / us-east1
GCP_ZONE="${GCP_ZONE:-$(gcloud config get-value compute/zone 2>/dev/null || true)}"
if [[ -z "$GCP_ZONE" || "$GCP_ZONE" == "(unset)" ]]; then
  GCP_ZONE="us-central1-a"
fi

MACHINE_TYPE="${MACHINE_TYPE:-e2-micro}"      # Always Free
BOOT_DISK_SIZE="${BOOT_DISK_SIZE:-30GB}"      # Always Free: до 30GB pd-standard
BOOT_DISK_TYPE="${BOOT_DISK_TYPE:-pd-standard}"

GC() {
  gcloud --project "$GCP_PROJECT" "$@"
}

VSSH() {
  # VSSH [--] remote command...
  GC compute ssh "$VM_NAME" --zone "$GCP_ZONE" -- "$@"
}

echo "== project=$GCP_PROJECT zone=$GCP_ZONE vm=$VM_NAME" >&2
