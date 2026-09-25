#!/bin/sh
APP="$(CDPATH= cd -- "$(dirname -- "$0")/../Resources/app" && pwd)" || exit 1
ACTION=$(/usr/bin/osascript -e 'button returned of (display dialog "Glorycourse 수강 관리" buttons {"자료 폴더", "종료", "시작"} default button "시작" with title "Glorycourse")') || exit 0
case "$ACTION" in
  시작) ACTION=start ;;
  종료) ACTION=stop ;;
  *) ACTION=data ;;
esac
if ! MESSAGE=$("$APP/runtime/node" "$APP/scripts/launcher.mjs" "$ACTION" 2>&1); then
  export GLORYCOURSE_MESSAGE="$MESSAGE"
  /usr/bin/osascript -e 'display alert "Glorycourse 실행 확인" message (system attribute "GLORYCOURSE_MESSAGE") as critical'
  exit 1
fi
if [ "$ACTION" = stop ]; then
  /usr/bin/osascript -e 'display dialog "프로그램이 종료되었습니다." buttons {"확인"} default button "확인" with title "Glorycourse"'
fi
