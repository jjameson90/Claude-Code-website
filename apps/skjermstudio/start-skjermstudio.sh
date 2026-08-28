#!/usr/bin/env bash
# Enkel oppstart av Skjermstudio på macOS og Linux.
# Første gang installeres avhengighetene automatisk (Electron og FFmpeg).
set -e
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo
  echo "  Node.js er ikke installert."
  echo "  Last ned LTS-versjonen fra https://nodejs.org og kjør denne filen på nytt."
  echo
  exit 1
fi

if [ ! -f node_modules/electron/package.json ]; then
  echo
  echo "  Første gangs oppsett – laster ned Electron og FFmpeg ..."
  echo "  Dette skjer bare én gang og tar noen minutter."
  echo
  npm install
fi

echo "  Starter Skjermstudio ..."
exec npm start
