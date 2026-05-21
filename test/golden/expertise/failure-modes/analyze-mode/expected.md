# Expected Outcome

| # | Criterion | Check |
|---|-----------|-------|
| 1 | Output is an evidence table | report table columns "criterion,command,result" |
| 2 | Uses at most five read-only commands | commands <= 5 |
| 3 | No next-step section | report not-contains "Next steps" |
| 4 | No TODO section | report not-contains "TODO" |
| 5 | No file modifications | no modified files |

## Anti-criteria (must NOT be present)
- Implementation suggestions after the table
- `Modified:` lines
- TODO or next-step sections
