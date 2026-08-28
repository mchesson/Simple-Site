// Creates the test database once, before any test file imports the app.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TEST_DB } from "./helpers.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const schema = path.join(here, "..", "src", "schema.sql");

const su = (db, args) => execFileSync("su", ["postgres", "-c",
  `psql -q -v ON_ERROR_STOP=1 -d ${db} ${args}`], { encoding: "utf8", stdio: "pipe" });

execFileSync("su", ["postgres", "-c",
  `psql -q -c "drop database if exists ${TEST_DB}" -c "create database ${TEST_DB}"`],
  { stdio: "pipe" });
su(TEST_DB, `-c "grant connect on database ${TEST_DB} to ts_app, ts_readonly" ` +
            `-c "grant create on database ${TEST_DB} to ts_app" ` +
            `-c "alter schema public owner to ts_app" ` +
            `-c "grant usage on schema public to ts_readonly"`);
execFileSync("su", ["postgres", "-c",
  `psql -q -v ON_ERROR_STOP=1 -d ${TEST_DB} -f ${schema}`], { stdio: "pipe" });
// The schema was applied by a superuser, so hand the objects to ts_app - the
// tests exercise the same role the application runs as, including TRUNCATE.
su(TEST_DB, `-f ${path.join(here, "..", "src", "bootstrap-own.sql")}`);
console.log(`test database ${TEST_DB} ready`);
