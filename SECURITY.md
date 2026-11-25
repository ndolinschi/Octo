# Security policy

Octo runs coding agents that can read and write files and execute commands on your computer, so security reports are
taken seriously.

## Supported versions

Octo is in early development and has no releases yet. Only the latest commit on `main` is supported; fixes are not
backported.

## Reporting a vulnerability

**Please do not report security problems in public issues, discussions or pull requests.**

Report privately through GitHub's private vulnerability reporting:
[**Report a vulnerability**](https://github.com/ndolinschi/Octo/security/advisories/new) (repository → *Security* →
*Advisories* → *Report a vulnerability*).

Please include:

- what the problem is and what an attacker could do with it;
- the steps or a proof of concept to reproduce it, and the commit you tested;
- your operating system and how you ran Octo (desktop app, `pnpm dev:all`, harness on its own, Remote access, router).

You should get an acknowledgement within 7 days. This is a small project maintained in spare time, so please allow
reasonable time for a fix before any public disclosure; we will agree on a disclosure date with you and credit you in the
advisory unless you prefer otherwise.

## Scope

In scope, for example:

- the harness's local HTTP/SSE bridge (authentication, origin checks, path confinement, approvals that can be bypassed);
- Remote access and phone pairing;
- secrets handling (API keys, form secrets) and anything that could leak them into logs, transcripts or model requests;
- the Tauri desktop shell and its sidecar management;
- the router's handling of upstream keys and budgets.

Out of scope: what a coding agent does after **you** approved it, issues in third-party agent programs or model providers,
and problems that need an attacker who already controls your user account.
