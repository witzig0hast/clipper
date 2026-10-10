# Clipper – Instant Replay für Windows

Clipper nimmt im Hintergrund **dauerhaft die letzten 20 Minuten** deines Spiels auf (Ringpuffer).
Passiert etwas Cooles: Hotkey drücken (Standard **Alt+F10**) – der Clip landet sofort als **MP4** in
`Videos\Clipper`. In der App kannst du Clips ansehen, **zuschneiden**, umbenennen und löschen.

## Features
- 🎮 **Automatische Aufnahme**, sobald ein Spiel läuft (Liste editierbar) – oder „Immer“ / „Manuell“
- ⏪ Puffer 1–30 min, 30/60 FPS, 720p–Original, Bitrate einstellbar
- 🔊 Spiel-/Systemton + optional Mikrofon (über OBS, perfekt synchron)
- ⌨️ Globaler Hotkey, Standard-Länge wählbar; zusätzlich Slider/Schnellwahl in der App („letzte 47 s“, „Alles“)
- ✂️ Eingebauter Schnitt-Editor; Clips werden verlustfrei als H.264-MP4 gespeichert
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
Clipper nimmt **nicht selbst** auf, sondern steuert ein mitgeliefertes **OBS Studio** unsichtbar im Hintergrund –
dieselbe Technik wie bei Streamern mit 150+ FPS: **Spielaufnahme (Game Capture, direkt auf dein erkanntes Spiel gerichtet)** + **Hardware-Encoder**
(NVIDIA NVENC / AMD AMF / Intel QuickSync). OBS streamt nur lokal (127.0.0.1) an Clipper, das den Strom ohne
Neu-Kodieren (`-c copy`) in 10-s-Segmente schreibt. **Clips entstehen ebenfalls ohne Neu-Kodieren** – beim Speichern
fällt also keine GPU-/CPU-Last an.

Zusätzliche Schutzmechanismen:
- OBS und ffmpeg laufen mit **niedriger Priorität**, OBS-Vorschau ist aus, die Oberfläche nutzt keine GPU.
- **Automatische Entlastung:** Verpasst OBS dauerhaft Frames (PC überlastet), reduziert Clipper erst auf 30 FPS,
  dann auf 720p/30 und pausiert zuletzt die Aufnahme („Notbremse“).
- Fällt der Hardware-Encoder aus, geht Clipper nur auf **sanften** Software-Modus (max. 720p/30) zurück und zeigt das gelb an.
- Stürzt OBS ab, startet Clipper es neu (max. 3×); verwaiste OBS-Prozesse werden beim Start beendet.
- Unter *Einstellungen → Diagnose* siehst du live OBS-CPU, FPS und verpasste Frames.

## Hinweise
- Installiere Clipper **nur für den aktuellen Benutzer** (Standard) – OBS legt seine Konfiguration im Programmordner ab.
- Aufnahme-Art: *Spielaufnahme* (Standard, am schlankesten) · *Spiel + Bildschirm-Reserve* · *Nur Bildschirm*. Bei schwarzem Bild eine der anderen wählen.
- Das mitgelieferte OBS belegt ca. 120–250 MB RAM, solange aufgenommen wird; ohne Aufnahme läuft nichts davon.
- Spiele am besten in **„Vollbild-Fenster“ / „Rahmenlos“** laufen lassen. Bei exklusivem Vollbild kann das Bild schwarz sein.
- Der Puffer liegt als temporäre Segmente in `%APPDATA%\Clipper\buffer` (ca. 1,8 GB bei 20 min / 12 Mbit/s) und wird beim Beenden gelöscht.
- Der Installer ist durch das mitgelieferte OBS ca. 100–150 MB groß.
- Schließen (X) schickt Clipper in den Tray; Beenden über Rechtsklick auf das Tray-Icon.

## So funktioniert es
`src/main/obs.js` startet OBS mit isolierter Konfiguration und steuert es per obs-websocket (Quellen, Stream).
`src/main/segmenter.js` empfängt den lokalen RTMP-Strom und schreibt Segmente; `src/main/exporter.js` setzt die letzten
N Sekunden verlustfrei zusammen (Start rastet auf einen Keyframe ein, Abweichung < 1–2 s).
`npm run integration` testet die ganze Kette mit echtem OBS; die CI läuft das unter Windows.
Lizenzhinweise: siehe `THIRD-PARTY.md` (OBS Studio ist GPL, wird unverändert als separates Programm mitgeliefert).
