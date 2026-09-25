#!/bin/sh
cd -- "$(dirname -- "$0")" || exit 1
if ! ./runtime/node ./scripts/launcher.mjs ACTION; then
  if command -v zenity >/dev/null 2>&1; then
    zenity --error --title="Glorycourse" --text="실행하지 못했습니다. 자료 폴더의 launcher.log와 README 안내를 확인하세요."
  else
    printf '\n실행하지 못했습니다. README 안내를 확인하세요. Enter를 누르면 닫힙니다.\n'
    read -r answer
  fi
  exit 1
fi
