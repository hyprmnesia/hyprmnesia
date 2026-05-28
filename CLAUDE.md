# Claude Notes

- `hpm quit` and the tray menu item "Quit Hyprmnesia" are full shutdown paths:
  they must stop the capture daemon before exiting the tray. Do not make quit
  tray-only again.
- There must never be multiple tray icons. Any command path that needs to launch
  the tray must first check for an existing live tray and launch it only when no
  tray exists. Headless/test/internal flows should use `_daemon`, `_status`, and
  `_stop` rather than public commands that may open UI.
