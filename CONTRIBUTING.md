# Contributing

Jevgrep is maintained as a small, dependable tool for coding agents. A pull
request should make the product easier to use or maintain without creating a
new standing obligation for every future release.

## Before opening a pull request

Start from current `main` and keep one change in one pull request. Explain the
user-facing contract, the reason for the change, and the checks that support
it. Keep measurements honest: identify the fixture, provider, and limits of a
benchmark instead of presenting a local result as a general guarantee.

Use an existing extension point before adding a new one. In particular, custom
provider endpoints are the path for additional compatible backends; adding a
built-in provider needs a clear maintenance benefit that custom endpoints
cannot provide.

## How pull requests are reviewed

Review starts with the contract at the boundary the change touches: command
output, provider requests, cache entries, packaged files, or a module API. The
implementation should have one clear owner for each concept and should remove
obsolete paths when it replaces them.

A change is a good merge candidate when it solves a real user or maintenance
problem, is focused, current with `main`, covered by behavior-level tests, and
does not add avoidable configuration, release, provider, or operational
maintenance. A merge conflict is an integration task, not a reason to reject
an otherwise valuable change. Reviewers should rebase or port the change before
deciding its product value.

Reviewers run the narrowest check that proves the change, then the full
verification described in the [development guide](README.md#development) when
the complete slice is ready. Release and package changes also follow [the
release guide](scripts/RELEASING.md).

Reviewers request changes when the idea fits but the contract, tests, failure
behavior, or maintenance cost is not yet clear. They close a pull request when
it is spam, duplicates an existing capability, expands the default surface
without a durable need, requires new account or deployment configuration, or
adds more long-term complexity than the problem justifies.

## What a merged change must leave behind

- The behavior and failure modes are pinned by tests that exercise the product
  contract rather than implementation details.
- The user-facing output is checked directly when output changes.
- Documentation explains the principle and points to the code that owns the
  current details; it does not copy command matrices or file inventories.
- The repository remains installable and releasable through the existing path.

Contributors do not need to solve unrelated cleanup in the same pull request.
Small, well-scoped changes are easier to verify and less likely to become
maintenance debt.
