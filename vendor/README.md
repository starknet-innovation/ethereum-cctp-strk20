# Vendored dependencies

The privacy SDK tarball in this directory is built from the exact upstream commit recorded in
`docs/ARCHITECTURE.md`. It is vendored because the official package is hosted on GitHub Packages
and unauthenticated CI cannot install it.

The vendored package metadata marks `starknet-devnet` as an optional peer dependency. The web app
does not use the SDK's Node-only devnet test helper, so installing it as a runtime dependency would
unnecessarily include the vulnerable, unmaintained `decompress` package. Consumers of the SDK's
`./testing` entry point must install `starknet-devnet` separately.
