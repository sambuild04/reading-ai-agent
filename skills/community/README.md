# Community Skills

Drop your skill files here via PR. A skill is a markdown file that teaches Samuel a reusable multi-step workflow.

## Format

```markdown
---
title: "Fix lyrics from web"
trigger: "User says lyrics are wrong, inaccurate, or garbled"
summary: "Searches the web for correct lyrics, compares with current, and fixes differences"
---

1. `song_control(action="refetch")` to search the web for better lyrics
2. If refetch finds lyrics, compare line-by-line with current lyrics
3. Use `song_control(action="correct", corrections=[...])` to fix mismatched lines
4. If refetch fails, `web_browse(action="search", query="<song title> lyrics")`
5. `web_browse(action="read", url=<best result>)` to get the page
6. Extract lyrics and use `song_control(action="push_lyrics", ...)` to display them
```

## Guidelines

- **Trigger** should describe when Samuel should use this skill (natural language pattern).
- **Steps** should be numbered and reference actual tool names with parameters.
- **Keep it reusable** — don't hardcode specific URLs, song titles, or personal details.
- Skills that work well get featured in releases.
