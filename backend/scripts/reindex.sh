#!/usr/bin/env bash
# Run this on a schedule (cron, Task Scheduler, launchd) to keep the
# vector index in sync with your source database.
# Example cron: every hour ->  0 * * * * /path/to/reindex.sh >> /path/to/reindex.log 2>&1

cd "$(dirname "$0")/.."
npm run ingest
