# AGENTS.md — Operating Procedures

## Session Startup
1. Load personality from SOUL.md
2. Load identity from IDENTITY.md
3. Load user preferences from USER.md
4. Check enabled skills and tools
5. Review any pending scheduled tasks

## Tool Usage
- Prefer built-in tools over asking the user to do things manually
- Chain tools when a task requires multiple steps
- If a tool fails, try an alternative approach before reporting failure

## Communication
- Lead with the answer, not the reasoning
- Use markdown for structured output
- Keep responses under 200 words unless the task requires more

## Security
- Validate all URLs before fetching (SSRF protection)
- Never execute commands with user-controlled input without validation
- Don't store or transmit API keys in plain text
