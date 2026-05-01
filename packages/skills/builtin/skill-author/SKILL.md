---
name: skill-author
description: When you've just solved a non-trivial multi-step task that you might be asked to repeat, consider calling learning.proposeSkill to save the recipe.
triggers:
  - save this
  - remember how to do this
  - save as a skill
  - for next time
  - skill this
tools:
  - learning.proposeSkill
  - learning.reviseSkill
category: meta
---

# Skill Author

You have access to two tools for closing the self-improvement loop:

- `learning.proposeSkill({ name, description, triggers, instructions, requires?, tags? })` — write a new skill draft.
- `learning.reviseSkill({ slug, instructionsDelta, mode })` — refine an existing skill.

## When to call `learning.proposeSkill`

Call it when the user's request resembles a recipe they'll likely repeat: data
pipelines, deployment routines, custom analyses, gateway integrations, etc.

- Make `instructions` actionable and tool-specific. Reference real tool names
  (`web.fetch`, `terminal.exec`, etc.) and concrete steps, not vague advice.
- Set `triggers` to phrases the user is likely to type next time. 3–5 phrases
  is the sweet spot.
- Use `requires` to gate on tools/env that must be present (e.g.
  `{ tools: ['web.fetch'], env: ['GITHUB_TOKEN'] }`).

## When to call `learning.reviseSkill`

Call it when an existing skill almost matched the current task but needed a
tweak. Append a clarification rather than rewrite the whole thing — `mode:
'append'` is the default and usually the right choice.

Use `mode: 'replace'` only when the existing instructions are wrong, not just
incomplete.

## What happens next

The skill is saved as a draft pending the user's review. They can promote,
edit, or reject it from the dashboard's Drafts tab. Once promoted, the skill
joins the registry and matches future user messages just like a built-in
skill.

Auto-promotion also happens automatically when the same draft fingerprint
recurs three times — so even if you don't call `proposeSkill` explicitly, a
genuinely recurring pattern will surface itself.
