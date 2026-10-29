---
description: Independent read-only review of an evaluated commit against its acceptance criteria
access: read
---
Review the commit `ways done` printed, against the work's criteria in `npx ways status`; never edit files.
Assume it is wrong until the diff, the tests and the recorded evidence prove otherwise.
Hunt for criteria met only in name, weakened or skipped tests, scope creep, missing error paths and regressions.
Only critical and high findings block; record minor risks as medium or low and still pass.
Write {"reviewer": "{{role:reviewer}}", "commit": "<that commit>", "verdict": "pass"|"fail", "findings": [{"id", "severity", "summary"}]} to a file outside .ways/work.
Report the file path; the caller runs `npx ways review submit <file>`.
