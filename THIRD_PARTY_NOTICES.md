# Third-party notices

This repository is licensed under MIT (see `LICENSE`). The following components
are used as installed dependencies, are not vendored here, and keep their own
licences. The MIT licence above does not apply to them.

## dsh-workbuddy-connect

- Version: 0.7.6
- Licence: MIT
- Copyright (c) 2026 Corrine Hu
- Used by: `adapter.mjs`, which loads the installed helper at runtime and
  verifies its SHA-256 before use. No upstream implementation is copied into
  this repository.
- The package's own `LICENSE` file sits beside the helper that `adapter.mjs`
  resolves; read it there for the canonical text.

## @deepseek-ai/dsh-atomic-write

- Licence: see the package's `LICENSE` in the installed `node_modules`.
- Used by: `adapter.mjs`, which imports the installed file after a hash check to
  satisfy a peer dependency of the helper above.

## @deepseek-ai/dsh-home-paths

- Licence: see the package's `LICENSE` in the installed `node_modules`.
- Used by: `adapter.mjs`, same mechanism as above.

## Runtime dependencies

The gateway and dashboard use only Node.js built-in modules (`node:http`,
`node:crypto`, `node:fs`, `node:zlib`, `node:child_process`, `node:test`). There
is no npm dependency tree to audit beyond the three packages listed above.
