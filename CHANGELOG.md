# Changelog

All notable changes to AmazCGM are listed here. The newest version is at the top.

## 1.8.5
- When Zepp OS closes the AmazCGM screen, the watch reopens it about a minute sooner and reconnects to the sensor within seconds instead of minutes.
- Y-axis labels on the chart no longer overlap on round watches; the chart is a little taller there.
- Menu items and buttons in Settings now light up when tapped, so you can see that a tap registered. Scrolling the menu does not highlight items.
- New menu item at the top: a red **Disconnect** while the sensor session is on, a green **Connect** while it is off. **Disconnect** (after a confirmation) stops the sensor link and the background service, and the app no longer reopens or reconnects by itself until you tap **Connect**.
- Fixed an empty Settings menu after swiping back from **Nearby devices**.
- Reconnects about a minute sooner after the sensor drops the link, and no longer pauses for 3 minutes after the first series of failed reconnects. Failed logins at a very weak signal no longer count as a stuck watch Bluetooth.

## 1.8.4
- Fixed layout for T-Rex 3 Pro 44mm

## 1.8.3

- New way to send a sensor's keys to the watch: in AmazCGM for Android tap **Share JSON**, paste it in Zepp under AmazCGM settings with **Paste JSON**, then tap **Sync from phone** on the watch.
- Direct Bluetooth transfer from AmazCGM for Android to the watch, without the Zepp app. **Sync from phone** tries it first and falls back to the scan pasted in Zepp.
- New **Nearby devices** menu item that lists the Bluetooth devices the watch saw, for troubleshooting.
- The Zepp settings page now shows only the sensor serial and patch info, with the JSON hidden behind a toggle.

## 1.6.5

- Experimental support for Amazfit T-Rex 3, T-Rex 3 Pro (48 mm and 44 mm), Balance 2, Balance 2 XT and Active Max, with layouts for round screens.

## 1.6.4

- Initial public release.
