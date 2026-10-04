# Clipper – Instant Replay für Windows

Clipper nimmt im Hintergrund **dauerhaft die letzten 20 Minuten** deines Spiels auf (Ringpuffer).
Passiert etwas Cooles: Hotkey drücken (Standard **Alt+F10**) – der Clip landet sofort als **MP4** in
`Videos\Clipper`. In der App kannst du Clips ansehen, **zuschneiden**, umbenennen und löschen.

## Features
- 🎮 **Automatische Aufnahme**, sobald ein Spiel läuft (Liste editierbar) – oder „Immer“ / „Manuell“
- ⏪ Puffer 1–30 min, 30/60 FPS, 720p–Original, Bitrate einstellbar
- 🔊 Spiel-/Systemton (Loopback) + optional Mikrofon
- ⌨️ Globaler Hotkey, Standard-Länge wählbar; zusätzlich Slider/Schnellwahl in der App („letzte 47 s“, „Alles“)
- ✂️ Eingebauter Schnitt-Editor, Export als H.264-MP4 (NVIDIA NVENC / AMD AMF / Intel QSV, sonst x264)
- 🔔 Piepton + Windows-Benachrichtigung beim Speichern, Tray-Icon, Autostart mit Windows

## Installieren
**Fertigen Installer holen:** Im GitHub-Tab *Actions → „Windows-Installer bauen“* den Artifact
`Clipper-Setup` herunterladen (oder bei einem `v*`-Tag unter *Releases*) und `Clipper Setup x.y.z.exe` ausführen.

**Selbst bauen (auf Windows):**
```bash
npm install
npm run dist        # -> dist\Clipper Setup 1.0.0.exe
```
**Entwickeln:** `npm start` · Tests: `npm test`

## Hinweise
- Spiele am besten in **„Vollbild-Fenster“ / „Rahmenlos“** laufen lassen. Bei exklusivem Vollbild kann das Bild schwarz sein.
- Der Puffer liegt als temporäre Segmente in `%APPDATA%\Clipper\buffer` (ca. 1,8 GB bei 20 min / 12 Mbit/s) und wird beim Beenden gelöscht.
- Schließen (X) schickt Clipper in den Tray; Beenden über Rechtsklick auf das Tray-Icon.

## So funktioniert es
Der Renderer nimmt den Bildschirm per Chromium-Capture auf und gibt alle 10 s ein (leicht überlappendes)
WebM-Segment an den Hauptprozess, der nur die letzten N Minuten behält. Beim Clip wird der laufende
Abschnitt „geflusht“, die passenden Segmente werden per ffmpeg zusammengesetzt und als MP4 kodiert
(`src/main/timeline.js`, `src/main/exporter.js`).
