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

## Performance (wichtig fürs Gaming)
Das Bild wird **direkt über ffmpeg** aufgenommen: Windows Desktop Duplication → Hardware-Encoder
(**NVIDIA NVENC / AMD AMF / Intel QuickSync**), also fast ohne FPS-Verlust – ähnlich wie ShadowPlay/OBS.
Nur wenn keine GPU-Encoder funktionieren, fällt Clipper auf x264 (CPU) zurück; das zeigt die App in Gelb an.
Der Ton kommt separat (Systemton/Mikrofon) und wird beim Clip anhand der Uhrzeit exakt zum Bild gelegt.
Der Aufnahme-Prozess läuft mit niedriger Priorität. Tipp: Auflösung „Original“ ist am schlankesten
(Skalieren muss auf der CPU passieren), 60 FPS reichen für Clips.

## Hinweise
- Spiele am besten in **„Vollbild-Fenster“ / „Rahmenlos“** laufen lassen. Bei exklusivem Vollbild kann das Bild schwarz sein.
- Der Puffer liegt als temporäre Segmente in `%APPDATA%\Clipper\buffer` (ca. 1,8 GB bei 20 min / 12 Mbit/s) und wird beim Beenden gelöscht.
- Schließen (X) schickt Clipper in den Tray; Beenden über Rechtsklick auf das Tray-Icon.

## So funktioniert es
ffmpeg schreibt das Bild fortlaufend als 10-s-MPEG-TS-Segmente (`src/main/capture.js`), der Renderer den
Ton als kurze, leicht überlappende WebM-Segmente. Der Hauptprozess behält nur die letzten N Minuten.
Beim Clip werden beide Spuren per Wanduhrzeit zugeschnitten, synchronisiert und als MP4 kodiert
(`src/main/timeline.js`, `src/main/exporter.js`).
