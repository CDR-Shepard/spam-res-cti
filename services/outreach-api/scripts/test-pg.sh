#!/bin/sh
# Real-Postgres test lane for outreach-api (root: `npm run test:pg`, which
# builds the packages first). Starts a throwaway postgres:16 in Docker, waits
# until it accepts TCP connections, runs the outreach-api suite with
# TEST_DATABASE_URL set — so the describe.skipIf(!pgLane) suites run — and
# always removes the container. Exits with the test run's status.
set -eu

NAME=outreach-test-pg
PORT="${TEST_PG_PORT:-55432}"

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT
trap 'cleanup; exit 130' INT TERM

cleanup
docker run --rm -d --name "$NAME" -e POSTGRES_PASSWORD=pg -p "$PORT:5432" postgres:16 >/dev/null

# The image's entrypoint runs a socket-only bootstrap server first; TCP answers
# only once the real server is up (about 4 s on a warm machine).
tries=0
until docker exec "$NAME" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1; do
  tries=$((tries + 1))
  if [ "$tries" -ge 60 ]; then
    echo "test-pg: postgres did not accept connections within 60 s" >&2
    exit 1
  fi
  sleep 1
done

TEST_DATABASE_URL="postgres://postgres:pg@localhost:$PORT/postgres" npm -w services/outreach-api run test
