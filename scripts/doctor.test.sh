#!/usr/bin/env bash

set -Eeuo pipefail

project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
doctor_script="$project_root/scripts/doctor.sh"
test_root="$(mktemp -d "${TMPDIR:-/tmp}/spindle-doctor.XXXXXX")"
fake_bin="$test_root/bin"
mkdir -p "$fake_bin"
trap 'rm -rf -- "$test_root"' EXIT

printf '%s\n' \
  '#!/usr/bin/env bash' \
  'printf "v24.0.0\\n"' \
  > "$fake_bin/node"

printf '%s\n' \
  '#!/usr/bin/env bash' \
  'printf "11.0.0\\n"' \
  > "$fake_bin/npm"

printf '%s\n' \
  '#!/usr/bin/env bash' \
  'if [[ "${FAKE_FORGE_FAIL:-0}" == "1" ]]; then exit 9; fi' \
  'printf "forge Version: 1.0.0-stable\\n"' \
  > "$fake_bin/forge"

printf '%s\n' \
  '#!/usr/bin/env bash' \
  'if [[ "${FAKE_SCARB_FAIL:-0}" == "1" ]]; then exit 9; fi' \
  'printf "scarb %s\\n" "${FAKE_SCARB_VERSION:-2.17.0}"' \
  > "$fake_bin/scarb"

chmod +x "$fake_bin/node" "$fake_bin/npm" "$fake_bin/forge" "$fake_bin/scarb"
test_path="$fake_bin:/usr/bin:/bin"

assert_fails_with() {
  local expected="$1"
  shift
  local output

  if output="$("$@" 2>&1)"; then
    printf 'expected failure containing %q, but doctor succeeded\n' "$expected" >&2
    exit 1
  fi
  if [[ "$output" != *"$expected"* ]]; then
    printf 'expected failure containing %q, got:\n%s\n' "$expected" "$output" >&2
    exit 1
  fi
}

assert_succeeds_with() {
  local expected="$1"
  shift
  local output

  if ! output="$("$@" 2>&1)"; then
    printf 'expected success containing %q, got:\n%s\n' "$expected" "$output" >&2
    exit 1
  fi
  if [[ "$output" != *"$expected"* ]]; then
    printf 'expected success containing %q, got:\n%s\n' "$expected" "$output" >&2
    exit 1
  fi
}

assert_fails_with \
  "forge exists but could not run" \
  env PATH="$test_path" FAKE_FORGE_FAIL=1 FAKE_SCARB_FAIL=0 FAKE_SCARB_VERSION=2.17.0 \
  bash "$doctor_script"

assert_fails_with \
  "scarb exists but could not run" \
  env PATH="$test_path" FAKE_FORGE_FAIL=0 FAKE_SCARB_FAIL=1 FAKE_SCARB_VERSION=2.17.0 \
  bash "$doctor_script"

assert_fails_with \
  "Scarb 2.17 or newer is required; found scarb 2.16.0" \
  env PATH="$test_path" FAKE_FORGE_FAIL=0 FAKE_SCARB_FAIL=0 FAKE_SCARB_VERSION=2.16.0 \
  bash "$doctor_script"

assert_succeeds_with \
  "ok     scarb 2.17.0" \
  env PATH="$test_path" FAKE_FORGE_FAIL=0 FAKE_SCARB_FAIL=0 FAKE_SCARB_VERSION=2.17.0 \
  bash "$doctor_script"

printf 'doctor regression tests passed\n'
