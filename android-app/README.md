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

- the managed work profile exposes a loopback-only SOCKS5 relay on
  `127.0.0.1:38483` and permits only the Agent WebUI host on port 443;
- the personal owner profile exposes a loopback-only PAC/HTTP CONNECT bridge on
  `127.0.0.1:38484`, with its PAC at
  `http://127.0.0.1:38484/proxy.pac`, and advertises that PAC to Chrome through
  a Chrome-only split `VpnService`;
- all other destinations are `DIRECT` in the PAC and are rejected by the
  bridge itself.

Both roles are foreground services, restart after boot, and share no public
listener. The personal bridge reaches the work-profile SOCKS listener through
Android's shared loopback network. Its Chrome-only VPN occupies the personal
profile's VPN slot, while work-profile Tailscale continues in the work profile's
separate slot. Stop the personal Agent Bridge before starting a personal-profile
VPN such as FlClash; start Agent Bridge when FlClash is not in use.
