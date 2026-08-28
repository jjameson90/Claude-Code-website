@echo off
rem Enkel oppstart av Skjermstudio pa Windows.
rem Forste gang installeres avhengighetene automatisk (Electron og FFmpeg).
setlocal
cd /d "%~dp0"
title Skjermstudio

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js er ikke installert.
  echo   Last ned LTS-versjonen fra https://nodejs.org og kjor denne filen pa nytt.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules\electron\package.json" (
  echo.
  echo   Forste gangs oppsett - laster ned Electron og FFmpeg ...
  echo   Dette skjer bare en gang og tar noen minutter.
  echo.
  call npm install
  if errorlevel 1 (
    echo.
    echo   Installasjonen feilet. Sjekk nettforbindelsen og prov igjen.
    pause
    exit /b 1
  )
)

echo   Starter Skjermstudio ...
call npm start
