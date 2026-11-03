@echo off
rem Comix: python -m comix ... из любой папки, например:  comix page scripts\example_page.yaml
chcp 65001 >nul
set "PYTHONUTF8=1"
cd /d "%~dp0"
py -3 -m comix %*
