@echo off
rem Браузерная игра локально (см. docs\GAME.md). Нужен Node.js 22: winget install OpenJS.NodeJS.LTS
chcp 65001 >nul
cd /d "%~dp0game"
if not exist node_modules call npm install
call npm run dev -- --open
