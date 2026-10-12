@echo off
rem dropsend launcher. Add this folder to PATH to run `drop ...` from anywhere.
rem
rem Kept ASCII-only on purpose: cmd.exe parses .cmd files using the console code
rem page, so non-ASCII comments would be mis-decoded into stray commands.
rem
rem Two directories are deliberately separated:
rem   * data (data/recv, state files) is always resolved relative to this
rem     project folder, so it does not move around depending on where you
rem     happened to type the command;
rem   * relative paths you pass on the command line are resolved against the
rem     directory you were in, which is what a CLI user expects.
rem The latter is handed to Node through DROP_CWD because we cd below.
setlocal
set "DROP_CWD=%CD%"
cd /d "%~dp0"
node "%~dp0bin\drop.js" %*
exit /b %ERRORLEVEL%
