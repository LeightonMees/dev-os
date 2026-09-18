# Security

## What DEV is, in security terms

DEV runs commands on your machine, reads and writes files in the projects you point it at, and sends
parts of those files to whichever AI providers you configure. Treat it as software with the same
reach as your own shell, because that is what it has.

It is designed for a single person on their own computer. It is **not** hardened for shared hosting,
multi-user machines, or exposure to a network.

## The trust boundary

| Component | Reachable from | Protection |
|---|---|---|
| Control plane HTTP API | loopback only (`127.0.0.1:47831` by default) | binds loopback; refuses requests whose `Host` is not loopback; refuses browser requests whose `Origin` is not DEV's own window |
| Desktop app | your session | talks to the control plane over loopback |
| Worker processes | spawned by you | inherit your user account and its permissions |
| Artifact previews | rendered in the app | sandboxed iframe with no same-origin access, served under a restrictive CSP |

The control plane has **no password**. Its safety rests entirely on being unreachable from anywhere
but this machine. Two consequences follow, and both matter:

- **Do not change `controlPlane.host` to `0.0.0.0`** or any routable address. Doing so publishes an
  unauthenticated remote-code-execution endpoint to your network. The setting exists for people who
  understand that and are putting their own authentication in front of it.
- **Anyone who can run code on your machine as you can drive DEV.** That is inherent to a local tool
  and is not a defect.

### Why the Origin check exists

A loopback server is reachable by any web page you have open, because the browser will happily send
requests to `127.0.0.1`. Without a check, a page could create and run a task on your machine while
you read an unrelated site. DEV therefore refuses any request carrying a browser `Origin` that is
not its own window, and refuses any request whose `Host` header is a name rather than loopback,
which closes DNS rebinding. Non-browser clients such as the CLI send no `Origin` and are unaffected.

## Secrets

- Keys live in `.dev-home/` and in your environment, never in the repository. `.dev-home/` and
  `.env*` are in `.gitignore`.
- DEV reads provider keys from environment variables named in its provider config (for example
  `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`). It does not store them in its database.
- Worker output is written to artifacts on disk. If a command prints a secret, that secret is now in
  an artifact file. Check before sharing artifacts.

## What gets sent to AI providers

Context is assembled by `assembleContext` under a token budget and sent to the worker you selected.
Workers never receive your whole repository or your backlog. What they do receive is the task, the
files it names, and bounded project context. If you enable a hosted provider, that content leaves
your machine and is subject to that provider's terms. Local models via Ollama do not leave.

## Reporting a vulnerability

Please report security issues privately rather than in a public issue:

- Use GitHub's **Report a vulnerability** button under the repository's Security tab, which opens a
  private advisory.

Include what you did, what happened, and what you expected. A proof of concept helps. Please give a
reasonable window for a fix before disclosing publicly.

There is no bounty programme. This is a personal project released in the hope it is useful.

## Supported versions

DEV is pre-1.0 in practice regardless of its version string. Fixes land on the default branch; there
are no backported security releases yet.
