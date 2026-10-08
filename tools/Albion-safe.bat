@echo off
setlocal
set "APP_EXE="

if exist "%LOCALAPPDATA%\Programs\Albion\Albion.exe" set "APP_EXE=%LOCALAPPDATA%\Programs\Albion\Albion.exe"
if not defined APP_EXE if exist "%LOCALAPPDATA%\Programs\Albion\albion.exe" set "APP_EXE=%LOCALAPPDATA%\Programs\Albion\albion.exe"
if not defined APP_EXE if exist "%LOCALAPPDATA%\Programs\Albion\VSCodium.exe" set "APP_EXE=%LOCALAPPDATA%\Programs\Albion\VSCodium.exe"
if not defined APP_EXE if exist "%LOCALAPPDATA%\Programs\Albion\Code.exe" set "APP_EXE=%LOCALAPPDATA%\Programs\Albion\Code.exe"
if not defined APP_EXE if exist "%LOCALAPPDATA%\Programs\Albion\codium.exe" set "APP_EXE=%LOCALAPPDATA%\Programs\Albion\codium.exe"
if not defined APP_EXE if exist "%LOCALAPPDATA%\Programs\VSCodium\VSCodium.exe" set "APP_EXE=%LOCALAPPDATA%\Programs\VSCodium\VSCodium.exe"
if not defined APP_EXE if exist "%LOCALAPPDATA%\Programs\VSCodium\Code.exe" set "APP_EXE=%LOCALAPPDATA%\Programs\VSCodium\Code.exe"
if not defined APP_EXE if exist "%LOCALAPPDATA%\Programs\VSCodium\codium.exe" set "APP_EXE=%LOCALAPPDATA%\Programs\VSCodium\codium.exe"

if not defined APP_EXE (
  echo Could not find Albion or VSCodium in the standard per-user install folders.
  pause
  exit /b 1
)

start "" "%APP_EXE%" --disable-gpu --no-sandbox
