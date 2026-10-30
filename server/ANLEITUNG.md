# Familien-Server für die Stube einrichten

Mit dem Familien-Server
- sind die Chats jeder Person auf allen ihren Geräten gleich (zum Beispiel Handy und Tablet),
- gilt das Monatsbudget pro Person für alle Geräte zusammen,
- schreibt Claude lange Antworten auf dem Server fertig, auch wenn das Handy ausgeht oder die App geschlossen wird,
- liegen die API-Schlüssel nur noch auf dem Server und nicht mehr auf den Geräten.

Der Server läuft kostenlos bei Cloudflare. Die Einrichtung dauert etwa 10 Minuten und geht am besten am PC.

## 1. Cloudflare-Konto anlegen

1. Öffne <https://dash.cloudflare.com/sign-up> und registriere dich mit E-Mail und Passwort.
2. Bestätige die E-Mail-Adresse über den Link in der Mail.
3. Einen kostenpflichtigen Tarif brauchst du nicht. „Free“ reicht.

## 2. Server aus GitHub anlegen

1. Im Cloudflare-Dashboard links auf **Compute (Workers)** bzw. **Workers & Pages** klicken.
2. **Create application** (oder **Erstellen**) wählen, dann **Import a repository** bzw. **GitHub**.
3. Falls gefragt: **Connect GitHub**. Erlaube Cloudflare den Zugriff auf das Repository **Stube** (es reicht, nur dieses eine Repository freizugeben).
4. Das Repository **Stube** auswählen.
5. Jetzt die Einstellungen ausfüllen:
   - **Project name / Worker name:** `stube-server`. Der Name muss genau so lauten.
   - **Root directory** (steht eventuell unter *Advanced settings*): `server`
   - **Build command:** leer lassen
   - **Deploy command:** `npx wrangler deploy` (ist meist schon eingetragen)
6. **Save and Deploy** bzw. **Deploy** klicken und etwa eine Minute warten.
7. Danach zeigt Cloudflare die Adresse des Servers, etwa
   `https://stube-server.DEIN-NAME.workers.dev`.
   Öffne sie im Browser. Dort sollte stehen: *„Stube-Server läuft.“*

Wenn ab jetzt etwas Neues auf GitHub hochgeladen wird, aktualisiert Cloudflare den Server von selbst.

## 3. Server mit der Stube verbinden (gleich danach erledigen)

Mach das auf dem Gerät, auf dem die Stube mit allen API-Schlüsseln schon eingerichtet ist.

1. Stube öffnen → **Einstellungen** → Karte **Familien-Server** → **Familien-Server verbinden**.
2. Die Adresse aus Schritt 2.7 einfügen → **Weiter**.
3. Zwei Passwörter festlegen, jeweils mindestens 8 Zeichen:
   - **Familien-Passwort:** Das brauchen alle Geräte der Familie.
   - **Admin-Passwort:** Das kennen nur die Eltern. Damit lassen sich Schlüssel, Modelle, Profile und Budgets ändern.
4. **Server einrichten** antippen. Die Stube lädt Einstellungen, Schlüssel, Profile, Chats und den bisherigen Verbrauch hoch und löscht danach die Schlüssel auf dem Gerät.

Wichtig: Richte den Server direkt nach dem Anlegen ein. Wer als Erstes die Passwörter festlegt, dem gehört der Server.

## 4. Weitere Geräte verbinden

Einfacher Weg mit Code:
1. Auf dem verbundenen Gerät: **Einstellungen → Familien-Server → Weiteres Gerät verbinden → Code erstellen**.
2. Den Code an das andere Gerät schicken und das Passwort getrennt davon sagen.
3. Auf dem neuen Gerät die Stube öffnen → **Einstellungen übernehmen** (Willkommensseite) bzw. **Familien-Server → Code einfügen**.

Oder von Hand: Willkommensseite → **Mit Familien-Server verbinden** → Adresse und Familien-Passwort eingeben.

Hatte das Gerät schon eigene Chats, werden die Chats von Profilen mit gleichem Namen übernommen (zum Beispiel „Paul“ auf dem Tablet zu „Paul“ auf dem Server).

Ohne Admin-Passwort sieht ein Gerät unter Einstellungen nur die Server-Seite. Dort kann man das Admin-Passwort eintragen, um alles zu ändern. Trag es nur auf Geräten der Eltern ein.

## Gut zu wissen

- **Kosten:** Der kostenlose Cloudflare-Tarif reicht für eine Familie bei Weitem (100.000 Anfragen pro Tag, 5 GB Speicher). Bezahlt werden weiter nur die KI-Anbieter, wie bisher.
- **Speicher:** Chats, Bilder, Videos und Musik liegen auf dem Server. Jedes Gerät hat eine Kopie, damit die App auch kurz ohne Netz funktioniert.
- **Gleichzeitig schreiben:** Schreibt dieselbe Person im selben Chat gleichzeitig auf zwei Geräten, gewinnt die zuletzt gespeicherte Fassung. Verschiedene Chats oder Personen stören sich nicht.
- **Hintergrund:** Läuft eine Antwort und das Handy geht aus, schreibt der Server sie fertig. Beim nächsten Öffnen der App erscheint sie im Chat. Bilder, Videos oder Dateien, die Claude erst nach dem Text erstellen wollte, werden dann nicht automatisch nachgeholt.
- **Passwort vergessen:** In Cloudflare unter dem Worker `stube-server` → **Settings** → **Delete** löschen und Schritt 2 wiederholen. Dabei gehen die Daten auf dem Server verloren; die Kopien auf den Geräten bleiben.
- **Vom Server trennen:** Einstellungen → Familien-Server → Trennen. Das Gerät arbeitet dann wieder allein, die API-Schlüssel müssen neu eingetragen werden.
