# Golden set for the extractor

Each `*.json` file is an array of hand-labelled cases:

```json
{
  "name": "short description",
  "text": "the Telegram post",
  "parents": ["optional reply chain, nearest first"],
  "expected": {
    "relevant": true,
    "all_clear": false,
    "events": [
      {
        "type": "shahed",
        "action": "update",
        "location": "Василівка",
        "toward": "Запоріжжя",
        "count": 3
      }
    ]
  }
}
```

Only the fields you set are checked; place names are compared through the gazetteer,
so "Васильевка" and "Василівка" are equal. Run with `pnpm eval` (needs `ANTHROPIC_API_KEY`).

Grow this set from real posts: `pnpm tg:dump` writes them to `data/samples/` (git-ignored) —
label the tricky ones and add them here.
