@echo off
rem Ночная генерация всех ассетов игры (см. docs\NIGHT.md). Можно прервать и запустить снова.
chcp 65001 >nul
cd /d "%~dp0"
call comix.bat night %*
echo.
echo Готово. Отчёт: build\night\report.html
pause
