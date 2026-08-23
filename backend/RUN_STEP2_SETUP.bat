@echo off
REM One-time setup for the Helpdesk Step 1+2 changes (MIGRATION_046).
REM Run this once from the backend folder (double-click it, or run it from a
REM terminal already cd'd into backend). Safe to run more than once — the
REM migration and seed script are both idempotent.

echo.
echo === Step 1/3: Running MIGRATION_046 (ticket_categories + is_internal_note) ===
node scripts\run-sql.js docs\MIGRATION_046_ticket_categories_internal_notes.sql
if errorlevel 1 goto :error

echo.
echo === Step 2/3: Seeding default ticket categories per company ===
node scripts\seed_ticket_categories.js
if errorlevel 1 goto :error

echo.
echo === Step 3/3: Regenerating backend\docs\DATABASE_SCHEMA.sql ===
node scripts\dump-schema.js
if errorlevel 1 goto :error

echo.
echo === Done. ===
echo Next: start dev.bat if it is not already running, then in a separate
echo terminal (from the backend folder) run:
echo     node docs\SMOKE_046_ticket_categories_internal_notes.js
echo.
pause
goto :eof

:error
echo.
echo === FAILED — see the error above. ===
pause
