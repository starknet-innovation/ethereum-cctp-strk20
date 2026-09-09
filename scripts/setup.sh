#!/usr/bin/env bash

set -Eeuo pipefail

project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_root"

if ! command -v node >/dev/null 2>&1; then
  echo "error: Node.js 24 is required but node was not found" >&2
  exit 1
fi

if ! node_version="$(node --version 2>/dev/null)"; then
  echo "error: node was found but could not run" >&2
  exit 1
fi

node_major="$(printf '%s\n' "$node_version" | sed -E 's/^v([0-9]+).*/\1/')"
if [[ "$node_major" != "24" ]]; then
  echo "error: Node.js 24 is required; found $node_version" >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "error: npm is required but was not found" >&2
  exit 1
fi

echo "Installing dependencies from package-lock.json..."
npm ci

copy_example() {
  local source_file="$1"
  local destination_file="$2"

  if [[ -e "$destination_file" ]]; then
    echo "Keeping existing $destination_file"
    return
  fi

  cp "$source_file" "$destination_file"
  echo "Created $destination_file from $source_file"
}

copy_example apps/api/.env.example apps/api/.env
copy_example apps/web/.env.example apps/web/.env.local

echo "Setup complete. Run 'npm run check' for the TypeScript workspace."
