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
  `127.0.0.1:38484` and `agent-macbook` at `127.0.0.1:38485`;
- the personal owner profile is only a launcher for those two localhost URLs,
  so it occupies no VPN slot and can coexist with personal-profile FlClash;
- only the two configured Agent WebUI HTTPS hosts are accepted by the SOCKS,
  CONNECT, and reverse-proxy paths.

Keep the work-profile Tailnet Relay and work-profile Tailscale running. The
service restarts after boot and has no public listener.
