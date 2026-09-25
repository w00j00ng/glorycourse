@echo off
chcp 65001 >nul
"%~dp0runtime\node.exe" "%~dp0scripts\launcher.mjs" ACTION
if errorlevel 1 pause
