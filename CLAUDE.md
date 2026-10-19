# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

All project guidelines (commands, build architecture, runtime data flow, AI coding principles) live in `AGENTS.md`, the single source of truth shared with other agents. It is imported here so Claude Code loads it automatically:

@AGENTS.md

## Notes not covered in AGENTS.md

- **JSX runtime escaping:** `src/utils/jsx-runtime.js` does not HTML-escape child text (only `"` in attribute values), so escape untrusted strings before interpolating them into webview markup.
