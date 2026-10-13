; clayclaude hotkey (AutoHotkey v2). Written by "clayclaude setup"; edit the values in the settings block or re-run setup.
;
; Press the hotkey to wake the tablet, bring the board to the front, and hand your PC keyboard and mouse to
; the tablet through scrcpy (control only, no video): the script activates the scrcpy window and clicks inside it,
; which is what makes scrcpy capture the mouse. Press the hotkey again, or close scrcpy, to take them back.
; Inside scrcpy, the Alt key (its shortcut key) also releases the mouse.
#Requires AutoHotkey v2.0
#SingleInstance Force
Persistent

; ---- settings (filled in by setup) ----
adbPath := "{{ADB}}"
scrcpyPath := "{{SCRCPY}}"
serial := "{{SERIAL}}"
chromePackage := "{{PACKAGE}}"
; ----------------------------------------

scrcpyPid := 0
serialArgs := serial = "" ? "" : " -s " serial
; scrcpy titles its window after the device unless told otherwise; Capture() finds the window by this title.
windowTitle := "clayclaude"

Hotkey "{{HOTKEY}}", Toggle

Toggle(*) {
    global scrcpyPid
    if (scrcpyPid && ProcessExist(scrcpyPid)) {
        Release()
        return
    }
    Grab()
}

Adb(args) {
    global adbPath, serialArgs
    RunWait '"' adbPath '"' serialArgs " " args, , "Hide"
}

Grab() {
    global adbPath, scrcpyPath, serialArgs, scrcpyPid, chromePackage, windowTitle
    Adb("shell input keyevent KEYCODE_WAKEUP")
    ; Chrome's launcher intent, as a tap on its icon: Chrome comes to the front showing the tab it had open (the board).
    ; No URL: an intent carrying the board's URL re-navigates that tab, which reloads the board.
    Adb("shell am start -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -p " chromePackage)
    ; scrcpy ships its own adb; ADB makes it use this one instead, so a different adb version never restarts the
    ; adb server (which would drop the daemon's adb reverse).
    EnvSet "ADB", adbPath
    Run '"' scrcpyPath '"' serialArgs " --no-video --no-audio --keyboard=uhid --mouse=uhid --window-title=" windowTitle, , "Hide", &scrcpyPid
    Capture()
}

; In uhid mode scrcpy captures the mouse (relative mode) on a click inside its window, and does not pass that click on
; to the tablet. So: wait for the window, bring it to the front, and click its centre.
Capture() {
    global scrcpyPid, windowTitle
    win := windowTitle " ahk_pid " scrcpyPid
    if !WinWait(win, , 10)
        return
    WinActivate win
    if !WinWaitActive(win, , 2)
        return
    CoordMode "Mouse", "Client"
    WinGetClientPos , , &w, &h, win
    Click w // 2, h // 2
}

Release() {
    global scrcpyPid
    try ProcessClose(scrcpyPid)
    scrcpyPid := 0
}
