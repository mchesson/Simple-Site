#!/usr/bin/env bash
# One command from a clean machine to a running workspace.
#
#   ./setup.sh          set up the database, seed it, and start the server
#   ./setup.sh --reset  throw the data away and start again
#
# Needs PostgreSQL 16 and Node 22 on the PATH, and a Postgres superuser you can
# reach (it uses whatever `psql` connects as by default).

set -euo pipefail
cd "$(dirname "$0")"

DB=${TS_DB:-ts_workspace}
SUPER=${TS_SUPERUSER_PSQL:-psql}

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die() { printf '\n\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

command -v node >/dev/null || die "Node is not on the PATH. Install Node 22 or later."
command -v psql >/dev/null || die "psql is not on the PATH. Install PostgreSQL 16 or later."

node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' \
  || die "Node 22 or later is needed. Found $(node -v)."

say "1/5  Installing dependencies"
npm install --silent

say "2/5  Creating the database"
if $SUPER -d postgres -lqt 2>/dev/null | cut -d\| -f1 | grep -qw "$DB"; then
  echo "     $DB already exists"
else
  $SUPER -q -d postgres -c "create database $DB" || die "Could not create $DB.

Two things this usually is:
  - Postgres is not running. Start it, then try again.
  - psql cannot connect as a superuser. Point it at one, for example:
      TS_SUPERUSER_PSQL=\"sudo -u postgres psql\" ./setup.sh"
  echo "     created $DB"
fi

say "3/5  Creating the two database roles"
# ts_app reads and writes. ts_readonly holds SELECT and nothing else, and is the
# connection the assistant's generated SQL travels on.
$SUPER -q -d "$DB" -v ON_ERROR_STOP=1 -f src/bootstrap.sql \
  || die "Role setup failed. This step needs a Postgres superuser - see above."

say "4/5  Building the schema and seeding demo data"
if [ ! -f .env ]; then
  sed "s/ts_workspace/$DB/g" .env.example > .env
  echo "     wrote .env - put your ANTHROPIC_API_KEY in it to enable the assistant"
fi
node src/seed.js --reset

say "5/5  Starting"
echo "     workspace   http://localhost:${PORT:-4000}"
echo "     inspector   http://localhost:${PORT:-4000}/inspect.html"
echo
exec node src/server.js
