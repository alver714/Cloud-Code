#!/usr/bin/env bash
# Creates the GCP VM for the bot. Run from Mac: ./deploy/01-create-vm.sh
cd "$(dirname "$0")"
source ./env.sh

if GC compute instances describe "$VM_NAME" --zone="$GCP_ZONE" >/dev/null 2>&1; then
  echo "VM $VM_NAME already exists — skipping creation."
else
  # --no-service-account --no-scopes: without a service account there is
  # nothing to steal from the metadata server — a compromised agent cannot get an
  # SA token (169.254.169.254) and pivot into the GCP project. Affects only NEW VMs.
  GC compute instances create "$VM_NAME" \
    --zone="$GCP_ZONE" \
    --machine-type="$MACHINE_TYPE" \
    --image-family=ubuntu-2404-lts-amd64 \
    --image-project=ubuntu-os-cloud \
    --boot-disk-size="$BOOT_DISK_SIZE" \
    --boot-disk-type="$BOOT_DISK_TYPE" \
    --no-service-account --no-scopes
fi

# Direct access to /preview (bypasses DNS filters that block trycloudflare)
if ! GC compute firewall-rules describe coding-bot-preview >/dev/null 2>&1; then
  GC compute firewall-rules create coding-bot-preview \
    --allow=tcp:8300-8399 --direction=INGRESS --source-ranges=0.0.0.0/0 \
    --target-tags=coding-bot-preview \
    --description="Direct preview ports for the coding bot"
fi
GC compute instances add-tags "$VM_NAME" --zone="$GCP_ZONE" --tags=coding-bot-preview

echo
echo "✅ VM created. Next: ./02-install.sh"
