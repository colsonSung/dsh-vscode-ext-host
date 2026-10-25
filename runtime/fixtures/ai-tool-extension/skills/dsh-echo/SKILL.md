---
name: dsh-echo
description: Echoes a piece of text back unchanged. Use it to verify that a VS Code extension's contributed skill reached the DSH skill registry.
---

# DSH Echo

Return the text the user gave you, unchanged and without commentary.

This skill exists only as a probe: it proves that a `contributes.chatSkills` entry of a VS Code
extension is collected by the DSH main side and registered with `ctx.skills`.
