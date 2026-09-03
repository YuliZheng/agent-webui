# Agent WebUI for Android

A small, security-focused Android shell for the existing Agent WebUI at:

`https://lggram.tail6c8b6c.ts.net/`

It intentionally does not bundle or duplicate the Vue frontend. The phone must
be connected to the same Tailscale network, and the existing WebUI service must
be reachable. Cookies and WebView storage keep the signed-in session local to
the app.

## Included behavior

- Full-screen WebView with the existing responsive/WeChat-style UI
- Same-origin-only in-app navigation
- External HTTPS, telephone, and email links open in their system apps
- Strict TLS validation and cleartext HTTP disabled
- File picker, authenticated downloads, back navigation, and retry screen
- Foreground Android notifications through a narrowly scoped JavaScript bridge
- Android 8.0 and newer (`minSdk 26`)

## Local build

Use the installed Android SDK and Gradle 7.4:

```powershell
$gradle = "$env:USERPROFILE\.gradle\wrapper\dists\gradle-7.4-all\aadb4xli5jkdsnukm30eibyiu\gradle-7.4\bin\gradle.bat"
& $gradle testReleaseUnitTest lintRelease assembleRelease
```

`assembleRelease` is signed only when `keystore.properties` exists. Keep the
keystore and its passwords private and backed up; losing it makes future APK
updates incompatible with an already installed copy.

## Cross-profile Agent relay

The `relay` module builds one package that chooses its role from the Android
profile where it runs:

- the managed work profile runs the only foreground service and exposes a
  loopback-only SOCKS5 listener on `127.0.0.1:38483`;
- that same service exposes fixed-origin Web bridges for the Windows Agent at
  `127.0.0.1:38484` and `agent-macbook` at `127.0.0.1:38485`; the Mac launcher
  reaches the latter through the equivalent `localhost:38485` host alias;
- a separate loopback-only raw TCP bridge at `127.0.0.1:38486` forwards only
  to the Windows Agent's RDP endpoint at
  `lggram.tail6c8b6c.ts.net:3389`;
- the personal owner profile is only a launcher for those two localhost URLs,
  so it occupies no VPN slot and can coexist with personal-profile FlClash;
- the MacBook launcher explicitly targets Chrome and combines the distinct
  `localhost` origin with `/agent-macbook-38485/` because Android WebAPK intent
  filters omit loopback ports; using `127.0.0.1` for both instances would make
  Chrome treat the 38485 PWA as the already-installed 38484 app;
- only the two configured Agent WebUI HTTPS hosts are accepted by the SOCKS,
  CONNECT, and reverse-proxy paths; the RDP bridge has its own single fixed
  destination and cannot be used as a general Tailnet proxy.

Keep the work-profile Tailnet Relay and work-profile Tailscale running. The
service restarts after boot and has no public listener.

For HyperOS devices that kill foreground services during one-key cleanup, the
personal-profile Relay screen offers an optional accessibility watchdog.
Managed profiles cannot host third-party accessibility services, so the
personal copy checks only the loopback Relay health endpoint and uses Android's
`CrossProfileApps` API to reopen the work copy when recovery is needed. It is
limited to this package and cannot retrieve window content, take screenshots,
or perform gestures. The recovery activity removes itself from Recents after
requesting the work foreground service. HyperOS must also allow the personal
Tailnet Relay package to display pop-up windows while running in the
background; otherwise the OS rejects the cross-profile recovery launch.

### Windows access over USB

ADB forwards host loopback ports through USB to the Relay listeners on the
phone. Recreate these mappings whenever the phone is unplugged and reconnected:

```powershell
.\adb.exe forward tcp:38484 tcp:38484
.\adb.exe forward tcp:13389 tcp:38486
```

Open `http://127.0.0.1:38484/` in Windows Chrome for Agent WebUI. For Remote
Desktop, connect to the nonstandard local port so it does not conflict with a
local RDP listener:

```powershell
mstsc.exe /v:127.0.0.1:13389 /f
```

The RDP bridge transports TCP only. Windows Remote Desktop falls back to TCP
when UDP is unavailable. With phone Wi-Fi disabled, the path is Windows USB to
the work-profile Relay, then the phone's mobile-data Tailscale connection; it
does not use the Windows host's corporate network.
