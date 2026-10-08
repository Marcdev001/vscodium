# Windows Startup Troubleshooting

## Collect diagnostics

1. Save the complete contents of `tools/win-diagnose.cmd` as `diag.cmd` on the Desktop.
2. Right-click `diag.cmd` and choose **Run as administrator**. If Windows asks for confirmation, approve it only if you trust the source of the script.
3. Let the three launch checks finish. Each waits about 15 seconds. Press Enter at the final prompt if requested.
4. Send the `albion-diag-<timestamp>.zip` created on the Desktop.

The script does not edit the installation. It launches the installed app, reads Windows logs and settings, and writes diagnostics to a temporary folder before zipping them. Logs can include your Windows user name, file paths, and workspace details; review and redact anything private before sharing.

## Decision tree

- **The safe launch survives but normal launch flashes and closes:** likely a graphics-driver or GPU-acceleration issue. Update the graphics driver from the PC or GPU manufacturer's official source. For a temporary test, run `tools/Albion-safe.bat`; it starts Albion with `--disable-gpu --no-sandbox`. The no-sandbox option reduces Chromium's security isolation, so use this only as a temporary test with trusted content.
- **Defender reports a threat or quarantined file:** check Windows Security > Virus & threat protection > Protection history. Do not restore a file or add an exclusion until the installer is confirmed as an authentic Albion release. If confirmed and the detection is a false positive, restore only that item and, if still necessary, exclude only the Albion installation directory. Never disable Defender globally or exclude broad folders.
- **`diag-vcredist.log` says the runtime key is missing or not installed:** install the current Microsoft Visual C++ 2015-2022 Redistributable (x64) from Microsoft's official download page, restart Windows, and try Albion again.
- **Logs point to profile or settings errors:** close Albion, back up `%APPDATA%\Albion` (or `%APPDATA%\VSCodium` for an older install), then rename that folder to `Albion.backup` (or `VSCodium.backup`) and launch again. Renaming resets the profile; do not delete the backup until needed settings and data are recovered.
- **Windows says the downloaded file is blocked:** only for an installer obtained from a trusted official source, right-click the installer, choose **Properties**, select **Unblock** if shown, then **Apply** and retry.
- **The installer itself flashes and closes:** inspect `diag-setup.log` and `diag-eventviewer.log`. The next installer build enables Inno Setup logging automatically; existing installer logs are included if present.
- **No branch above explains the failure:** send the zip and note whether it was the installer or the installed app that closed, what appeared on screen, and whether the safe launch behaved differently.

## What the diagnostic zip contains

- Three app launch logs: normal, verbose, and safe mode, including captured stdout/stderr and process-survival checks.
- The newest Albion and VSCodium main/renderer logs found in the current user's roaming profile.
- The newest Inno Setup log found in `%TEMP%`, recent Application error events, Defender status, Visual C++ runtime registry state, GPU/driver information, Windows build, memory, and C: drive free space.
