# Stube – Projektstand (zum Weitermachen in einem neuen Chat)

Stand: 30.10.2026

## Worum es geht
„Stube“ ist eine Familien-KI-Chat-App (PWA) als Ersatz für mehrere Claude-Pro-Abos. Sie nutzt API-Schlüssel (Claude Console, OpenAI, OpenRouter, Gemini, eigene) und rechnet nach Verbrauch ab. Familie: Papa (Admin), Frau (iPhone), Kinder (u. a. Sohn mit Handy und Tablet).

- **Repository:** github.com/Familienplaner-droid/Stube (Branch `main`; großes „S“ beachten)
- **App-Adresse:** https://familienplaner-droid.github.io/Stube/
- **Dateien:** `index.html` (die ganze App, ca. 3500 Zeilen), `manifest.webmanifest`, `sw.js` (ohne Cache), Icons, `server/` (Familien-Server)
- **Veröffentlichen:** Änderungen nach `main` pushen, GitHub Pages aktualisiert sich selbst. Der Server wird per Cloudflare Workers Builds automatisch aus `server/` bereitgestellt (sobald eingerichtet).
- Der Nutzer ist noch in der Testphase und hat erlaubt, direkt zu veröffentlichen.

## Funktionen (fertig)
- **Bedienung:** Oberfläche wie die Claude-App, Profile mit Farbe, PIN, Kindermodus und Monatsbudget, Admin-PIN für die Einstellungen
- **Anbieter und Modellwahl:** Mehrere Anbieter und Modelle; **„Automatisch“** als Standard: ein günstiges Verteiler-Modell wählt pro Nachricht einfach / aktuell / code / komplex / medien
- **Websuche:** für Claude-Modelle
- **Artefakte:** HTML, React, SVG, Mermaid in einer Sandbox, Export als PNG, PDF oder Druck
- **Spezial-Modelle als Werkzeuge:** Das Grundmodell steuert sie selbst, auch mehrere nacheinander:
  - `erstelle_bild`: OpenAI und OpenRouter
  - `erstelle_video`: OpenRouter /videos mit Abfragen des Stands
  - `erstelle_musik`: Lyria über OpenRouter
  - `programmieren`: Code-Modelle
  - `erstelle_dokument`: echte PPTX-, DOCX-, XLSX- und PDF-Dateien über Claude code_execution mit Skills und der Files API
- **Preis-Leistung:** Preisliste im Systemhinweis, Rückfrage bei mehreren sinnvollen Modellen, Bestätigungskarte über dem Limit `autoLimit`; für Kinder Preisstufen („günstig/teuer“)
- **Schule:** Anhänge lesen (PDF, Word, Excel, PowerPoint, Text, Fotos), Formeln mit KaTeX, Plakate
- **Sprache:** Spracheingabe und Vorlesen über den Browser
- **Kosten:** Monatlicher Kostenzähler mit Prognose, Budget pro Profil, Fehlerprotokoll
- **Übertragung:** Einstellungen per verschlüsseltem Code übertragen (PBKDF2 + AES-GCM, Präfix „STUBE1:“)
- **Abbrüche:** Bildschirm bleibt während einer Antwort wach; unterbrochene Antworten werden automatisch fortgesetzt
- **Speicher:** IndexedDB mit Reparatur für das iPhone (Verbindung wird neu geöffnet), Ersatz: localStorage

## Familien-Server (neu, `server/`)
Cloudflare Worker mit einem Durable Object „family“ (SQLite), kostenloser Tarif. Anleitung: `server/ANLEITUNG.md`.

**Was er macht:**
- Gemeinsame Chats pro Person auf allen Geräten
- Gemeinsames Budget pro Person, vom Server erzwungen (Fehler 402)
- API-Schlüssel nur auf dem Server
- Antworten laufen als Hintergrund-Auftrag weiter, auch wenn das Handy ausgeht oder die App geschlossen wird

**Anmeldung:** Familien-Passwort (Header `x-stube-key`) und Admin-Passwort (`x-stube-admin`).

**Endpunkte:**
- `/api/hello`, `/setup`, `/check`, `/state`
- `/usage` (GET, POST)
- `/settings` und `/profiles` (PUT, nur Admin)
- `/chats`, `/chat` (GET, PUT, DELETE mit Löschvermerk)
- `/media/:sha256`
- `/proxy/:anbieterId/*`
- `/jobs` (POST, GET), `/jobs/:id?from=n` (Long-Poll), `DELETE /jobs/:id`

**In der App:**
- `SRV` (Konfiguration in localStorage „stube-server“)
- `pfetch` leitet Anfragen über den Proxy, `sfetch` macht Streaming- und Dokument-Anfragen zu Server-Aufträgen
- `recoverJobs`: holt fertige Antworten ab, Liste in localStorage „stube-jobs“
- `pushChats`, `pullChats`: Medien über 20.000 Zeichen werden als „@m:hash“ ausgelagert; bei gleichzeitigem Schreiben gilt die zuletzt gespeicherte Fassung
- `pullState`, `refreshFromServer`: beim Sichtbarwerden und alle 60 Sekunden
- `addUsage`: schickt Verbrauch an den Server, Warteschlange bei fehlendem Netz
- Bildschirm `showServer`: einrichten, verbinden, Admin freischalten, trennen
- Übertragungs-Code im Server-Modus enthält Adresse und Familien-Passwort (nie das Admin-Passwort)

**Getestet:** lokal mit `wrangler dev` und Test-Anbieter auf drei Geräten mit Playwright. Alles bestanden: Einrichtung, Verbindung, falsches Passwort, Netzabbruch, App mitten in der Antwort geschlossen, Budgetsperre, Medien-Abgleich, Löschen, Admin.

**Offen – muss der Nutzer selbst machen:** den Server bei Cloudflare anlegen:
1. Workers & Pages → Create application → Import a repository → **Stube**
2. Name `stube-server`, Root directory `server`, Deploy
3. In der App unter Einstellungen → Familien-Server die Adresse eintragen und zwei Passwörter festlegen
4. Weitere Geräte per Code verbinden

## Bekannte Hinweise und Lösungen
- **Fehler 400 „workspace“:** Workspace-ID beim Anbieter eintragen oder einen Schlüssel aus einem Workspace verwenden
- **iPhone:** Die Home-Bildschirm-App hat einen eigenen Speicher und muss dort eingerichtet werden (oder per Code); zum Home-Bildschirm nur über Safari hinzufügen, nicht über Firefox
- **Sora:** Die OpenAI-Video-API ist eingestellt, Videos laufen über OpenRouter

## Ideen und mögliche nächste Schritte
- Zusammenführen statt „zuletzt gespeichert gewinnt“, wenn derselbe Chat auf zwei Geräten gleichzeitig bearbeitet wird
- Bei Hintergrund-Antworten Folgeschritte wie Bilder oder Dateien automatisch nachholen
- Push-Benachrichtigung, wenn eine Hintergrund-Antwort fertig ist
