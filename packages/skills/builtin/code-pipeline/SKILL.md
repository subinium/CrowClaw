---
name: code-pipeline
description: When solving a task that needs multiple tool calls in sequence (e.g., fetch -> parse -> fetch -> store), prefer code.execute to chain them in one inference call.
triggers: ["in one step", "all at once", "as a pipeline", "without round-trips"]
tools: ["code.execute"]
---

You have access to `code.execute(language, code, allowedTools)`. Inside the sandbox, the global `tools` object exposes RPC access to the host's tool registry. Example:

```js
const result = await tools['web.fetch']({ url: 'https://example.com' });
const parsed = JSON.parse(result.content);
const summary = await tools['web.search']({ query: parsed.topic });
return { fetched: result, summary };
```

Use this when you can express the workflow procedurally and want to avoid per-step round-trips. Always declare the minimal set of `allowedTools`. Prefer single `code.execute` calls over multiple sequential agent turns when the steps are deterministic.

Notes:

- The sandbox is JS/TS only. Tool names with dots (e.g. `web.fetch`) must be invoked via bracket access: `tools['web.fetch'](args)`. An identifier-friendly alias (`tools.web_fetch`) is also exposed for convenience.
- Every host call still routes through plugins, hardline blocklist, redaction, and the approval gate — you cannot bypass safety policy by wrapping calls in `code.execute`.
- Default policy: 30 second wall-clock timeout, 50 host tool calls per run, 100 KB combined stdout/stderr. Destructive tools (manifest `safety: 'destructive'`) are blocked unless the operator has explicitly enabled `allowDangerous`.
- `console.log` output is captured into stdout, exceptions into stderr. Both are returned to the calling agent as part of the result.
- Return a value from your code to surface a structured result; otherwise the agent only sees stdout.
