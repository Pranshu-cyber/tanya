# Inspiration and prior art

Tanya is an independent coding-agent CLI. Its design is informed by public
tools and documentation, and its implementation should remain its own work.

## Public influences

| Project | Public source | What Tanya learns from it |
|---------|---------------|---------------------------|
| Claude Code | <https://docs.anthropic.com/en/docs/claude-code/overview> and <https://www.npmjs.com/package/@anthropic-ai/claude-code> | Terminal-first agent ergonomics, explicit tool execution, and permission-aware workflows. |
| opencode | <https://github.com/sst/opencode> | Open coding-agent UX, provider flexibility, and local developer workflow expectations. |
| Aider | <https://github.com/Aider-AI/aider> | Git-aware coding loops, practical CLI defaults, and a long-running open-source agent community. |
| Gemini CLI | <https://github.com/google-gemini/gemini-cli> | Public CLI packaging, command ergonomics, and examples for contributor-facing docs. |

## Tanya's own focus

Tanya's differentiator is the deterministic verifier and auditable final
report. Public prior art is useful for UX and packaging ideas, but verifier
authority stays load-bearing:

- Streaming output is UI/log-only; final tool results remain the model-facing
  record.
- Permission denials and cancellations should become explicit blockers.
- Examples and README claims should only describe behavior backed by tests or
  runnable examples.

No private or non-public implementation is copied into Tanya.
