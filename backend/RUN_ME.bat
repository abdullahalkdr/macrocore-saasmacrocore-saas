@echo off
cd /d "%~dp0"
echo === macrocore backend ===
echo Running migration against your Railway DB (safe to re-run; if tables already exist it will just print an error and continue)...
call npm run db:migrate
echo.
echo === Starting server on http://localhost:3001 ===
call npm run dev
pause
