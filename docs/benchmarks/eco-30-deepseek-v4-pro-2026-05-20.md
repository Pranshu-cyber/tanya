## Eval Report: eco-30

- Version: 2026-05
- Model: deepseek/deepseek-v4-pro
- Pass rate: 96.7% (29/30)
- Status: 29 passed, 0 failed, 0 errored, 1 timeout
- Total cost: $1.5221
- Cost/task: $0.0507
- Reasoning share: 2.0%

### Slowest tasks

| Task | Status | Metric |
| --- | --- | ---: |
| `eco-19-long-file-read-dedup` | timeout | 600.2s |
| `eco-25-long-file-read-dedup` | passed | 222.5s |
| `eco-21-reasoning-heavy-planning` | passed | 193.1s |

### Costliest tasks

| Task | Status | Metric |
| --- | --- | ---: |
| `eco-21-reasoning-heavy-planning` | passed | $0.1506 |
| `eco-25-long-file-read-dedup` | passed | $0.1109 |
| `eco-26-large-tool-result-truncation` | passed | $0.1092 |
