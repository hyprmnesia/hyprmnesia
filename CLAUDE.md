# Claude Notes

- `hpm quit` and the tray menu item `Quit Hyprmnesia` are full shutdown paths:
  stop the daemon first, then quit the tray.
- Do not create duplicate tray icons. Any user-facing command that needs the
  tray must check for an existing live tray before launching one.
- Headless, test, and internal control paths should stop the daemon directly and
  must not launch the tray as a side effect.
