#!/usr/bin/env bash
# Создаёт GCP VM для бота. Запускать с Mac: ./deploy/01-create-vm.sh
cd "$(dirname "$0")"
source ./env.sh

if GC compute instances describe "$VM_NAME" --zone="$GCP_ZONE" >/dev/null 2>&1; then
  echo "VM $VM_NAME уже существует — пропускаю создание."
else
  GC compute instances create "$VM_NAME" \
    --zone="$GCP_ZONE" \
    --machine-type=e2-standard-2 \
    --image-family=ubuntu-2404-lts-amd64 \
    --image-project=ubuntu-os-cloud \
    --boot-disk-size=50GB \
    --boot-disk-type=pd-balanced
fi

echo
echo "✅ VM создана. Дальше: ./02-install.sh"
