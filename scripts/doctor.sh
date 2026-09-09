#!/usr/bin/env bash

set -u

project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
if ! cd "$project_root"; then
  echo "error: could not enter project root: $project_root" >&2
  exit 1
fi

failures=0

pass() {
  printf 'ok     %s\n' "$1"
}

warn() {
  printf 'notice %s\n' "$1"
}

fail() {
  printf 'error  %s\n' "$1" >&2
  failures=$((failures + 1))
}

if command -v node >/dev/null 2>&1; then
  node_version="$(node --version 2>/dev/null)"
  node_status=$?
  if [[ $node_status -ne 0 || -z "$node_version" ]]; then
    fail "node exists but could not run"
  elif [[ "$node_version" == v24.* ]]; then
    pass "Node.js $node_version"
  else
    fail "Node.js 24 is required; found $node_version"
  fi
else
  fail "Node.js 24 is not installed"
fi

if command -v npm >/dev/null 2>&1; then
  npm_version="$(npm --version 2>/dev/null)"
  npm_status=$?
  if [[ $npm_status -eq 0 && -n "$npm_version" ]]; then
    pass "npm $npm_version"
  else
    fail "npm exists but could not run"
  fi
else
  fail "npm is not installed"
fi

if [[ -d node_modules ]]; then
  pass "JavaScript dependencies are installed"
else
  warn "JavaScript dependencies are missing; run 'npm run setup' or 'npm ci'"
fi

if command -v forge >/dev/null 2>&1; then
  forge_output="$(forge --version 2>/dev/null)"
  forge_status=$?
  forge_version="${forge_output%%$'\n'*}"
  if [[ $forge_status -eq 0 && -n "$forge_version" ]]; then
    pass "$forge_version"
  else
    fail "forge exists but could not run"
  fi
else
  warn "forge is missing; it is required only for EVM contract checks"
fi

if command -v scarb >/dev/null 2>&1; then
  scarb_output="$(scarb --version 2>/dev/null)"
  scarb_status=$?
  scarb_version="${scarb_output%%$'\n'*}"
  if [[ $scarb_status -ne 0 || -z "$scarb_version" ]]; then
    fail "scarb exists but could not run"
  elif [[ "$scarb_version" =~ ^scarb[[:space:]]+([0-9]+)\.([0-9]+) ]]; then
    scarb_major="${BASH_REMATCH[1]}"
    scarb_minor="${BASH_REMATCH[2]}"
    if (( 10#$scarb_major > 2 || (10#$scarb_major == 2 && 10#$scarb_minor >= 17) )); then
      pass "$scarb_version"
    else
      fail "Scarb 2.17 or newer is required; found $scarb_version"
    fi
  else
    fail "could not parse Scarb version: $scarb_version"
  fi
else
  warn "scarb is missing; it is required only for Starknet contract checks"
fi

if [[ -f apps/api/.env ]]; then
  pass "apps/api/.env exists"
else
  warn "apps/api/.env is absent; tests work without it and setup can create it"
fi

if [[ -f apps/web/.env.local ]]; then
  pass "apps/web/.env.local exists"
else
  warn "apps/web/.env.local is absent; tests work without it and setup can create it"
fi

if [[ $failures -gt 0 ]]; then
  printf '\nDoctor found %d blocking toolchain problem(s).\n' "$failures" >&2
  exit 1
fi

printf '\nEnvironment is ready for repository setup and local checks.\n'
