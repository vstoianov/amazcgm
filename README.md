# AmazCGM

**FreeStyle Libre 2+ (EU) glucose readings directly on the Amazfit Bip Max, over Bluetooth, with no phone in the loop.**

The watch connects to the sensor itself, unlocks the Bluetooth stream and shows a new reading every minute. Your phone can be off, at home or out of battery. You need a phone only once per sensor, to scan it with NFC.

> [!WARNING]
> **AmazCGM is not a medical device.** It is an independent hobby project. It is not made, approved or supported by Abbott, Zepp Health or Amazfit.
> Readings can be late, wrong or missing, and alarms can fail. **Do not make treatment decisions from this watch.** Confirm with your official reader, the official app or a finger-stick.
> You use it entirely at your own risk.

<!-- TODO: add a screenshot of the main screen and a link to a short demo video -->

## Features

- Live glucose in mmol/L with trend arrow and change since the last reading
- Chart with 3, 6 and 12 hour windows; tap to step back through up to 72 hours of history
- Low and high alarms with vibration and sound, also when the app is in the background
- Optional calibration against finger-stick values
- Automatic reconnect when the sensor goes out of range, with a background service that reopens the app if the watch closed it
- Debug log you can copy from the Zepp app settings, for bug reports

## Requirements

| | Supported |
|---|---|
| Watch | Amazfit Bip Max (Zepp OS 4) |
| Sensor | FreeStyle Libre 2 Plus, EU version |
| Setup phone | Android phone with NFC, once per sensor |

Other Libre models (Libre 2 US, Libre 3) and other watches are not supported.

## How it works

1. **Once per sensor:** scan the sensor with the [Libre2 Key](https://github.com/vstoianov/cgmnfc) Android app. It reads the sensor over NFC and produces a short scan JSON with the sensor's ID and Bluetooth unlock data.
2. Paste that JSON in the Zepp app: **Profile → Amazfit Bip Max → App settings → AmazCGM → Set JSON**, then open AmazCGM on the watch and sync.
3. **From then on, the watch works alone.** It finds the sensor's Bluetooth advert, logs in, sends the unlock command and decrypts each glucose packet on the watch.

The Libre 2 unlock and decryption maths is ported from [DiaBLE](https://github.com/gui-dos/DiaBLE) and [LibreTools](https://github.com/ivalkou/LibreTools). See [NOTICE](NOTICE) for credits.

## Install

### From a release

1. Download the latest `.zab` file from [Releases](../../releases).
2. Install it on the watch with the Zepp app in developer mode, or with `zeus preview` (see below).

### Build from source

You need Node.js 18 or newer and the [Zeus CLI](https://docs.zepp.com/docs/guides/tools/cli/).

```sh
npm install
npx zeus build      # creates dist/*.zab
npx zeus preview    # builds and shows a QR code to install through the Zepp app (developer mode)
npm test            # unlock and calibration unit tests
```

## Battery and known limits

<!-- TODO: add your measured battery life, for example "about N days with a reading every minute" -->

- Bluetooth on the Bip Max sometimes gets stuck after many hours. AmazCGM detects this, rebuilds the connection and, if that fails, tells you to restart the watch.
- When the sensor ends (after 15 days) or is replaced, scan the new one with Libre2 Key and paste the new JSON.
- Readings stop while the watch is out of Bluetooth range of the sensor, which is usually a few metres.

## Reporting a problem

Open an [issue](../../issues) and include:

- what happened and at what time,
- the app version (shown in the Zepp app under the watch's installed apps, or the release you installed),
- the debug log: in the Zepp app go to AmazCGM settings, tap **Copy log** and paste it into the issue.

The log contains your sensor's Bluetooth address. Remove it if you prefer.

## Support the project

AmazCGM is free and always will be. If it helps you, you can support further development:

- [GitHub Sponsors](https://github.com/sponsors/vstoianov)
- [Ko-fi](https://ko-fi.com/KOFI_USERNAME) <!-- TODO: replace KOFI_USERNAME -->

## License

AmazCGM is licensed under the [GNU General Public License v3.0 or later](LICENSE). You may use, study, change and share it. If you distribute a changed version, it must also be released under the GPL with its source code.

Bundled third-party code keeps its own MIT license. See [NOTICE](NOTICE).

FreeStyle Libre is a trademark of Abbott. Amazfit and Zepp are trademarks of Zepp Health. They are used here only to describe compatibility.
