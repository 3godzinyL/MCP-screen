# MPC Ekran

Serwer **MCP** (Model Context Protocol), który daje AI oczy i ręce w dowolnej aplikacji Windows:
robi zrzut ekranu, wykrywa przyciski i pola co do piksela, nakłada na nie **niebieskie strefy z podpisami**,
klika i pisze **ruchem człowieka** (nagranym od Ciebie) i układa **sekwencje kliknięć** do powtarzania.

Do tego **MPC Studio** — program do pokazu na klubie: obok siebie stara wersja (człowiek zaznacza
element po elemencie, jak w `bocikmexik`) i nowa wersja (AI robi to sama), plus podgląd na żywo,
co AI widzi i co klika.

Baza: `Desktop\bocikmexik` (nakładka z niebieskimi strefami, humanizer ruchu, nagrywanie F8).
Kod został przeniesiony i przebudowany; bocikmexik zostaje nietknięty.

---

## Start

```
npm install          (raz; Node 20+)
START_STUDIO.cmd     program do pokazu
START_AI.cmd         Claude Code z podłączonym serwerem (plik .mcp.json w tym folderze)
TEST_MPC.cmd         autotest tego komputera
npm test             testy jednostkowe + integracja MCP (tryb próbny, nic nie klika)
```

Podłączenie na stałe, w każdym projekcie Claude Code:

```
claude mcp add mpc-ekran -s user -- node "C:\Users\huber\Desktop\mpc\src\mcp\server.js"
```

Claude Desktop — `%APPDATA%\Claude\claude_desktop_config.json`:

```json
{ "mcpServers": { "mpc-ekran": { "command": "node", "args": ["C:\\Users\\huber\\Desktop\\mpc\\src\\mcp\\server.js"] } } }
```

`node src/cli.js config` wypisze te polecenia z właściwą ścieżką (np. na laptopie klubowym).

---

## Stara wersja a nowa

| | Stara (bocikmexik) | Nowa (MPC + AI) |
|---|---|---|
| Kto znajduje przyciski | człowiek, prostokąt po prostokącie | AI: UI Automation + OCR + analiza pikseli, ponumerowane strefy |
| Nowa aplikacja | kalibracja od zera i nowy kod kroków | `detect_elements` → `label_elements` |
| Okno się przesunęło | klik w stare współrzędne, czyli obok | element odnaleziony po wyglądzie (dopasowanie wzorca) |
| Skala ekranu 125–150% | współrzędne się rozjeżdżają | proces DPI-aware, fizyczne piksele, przeskalowany wzorzec |
| Ruch myszy | nagranie wybierane po nazwie | najbliższe nagranie po długości i kierunku, obrócone do celu, z szumem |
| Sekwencja | kod w `actions.js` | nagrana z działań AI albo człowieka, zmienne `{{…}}` |
| Bezpieczeństwo | brak | STOP, róg ekranu, przejęcie myszy, tryb próbny |

Stara kalibracja MEXC z bocikmexik wczytuje się przyciskiem w Studiu albo `node src/cli.js import-bocik`
(profil `mexc_bocik`, 20 stref, bez wzorców — dla porównania).

---

## Jak AI tego używa

```
screen_info → focus_window("Biuro Pomocy") → use_profile("biuro_pomocy")
detect_elements(window=…)        obraz z ponumerowanymi niebieskimi strefami + lista „#13 Edit "E-mail" @408,188 350x39”
label_elements(shot, items=[{mark:13, name:"pole_email"}, …])   wycinek, okno, podgląd z nazwą
sequence_record(start) → type_text / click / press_keys / wait(for_text) → sequence_record(stop)
sequence_run("zgloszenie")       później, także po przesunięciu okna
```

Serwer wysyła przy połączeniu instrukcję pracy (pole `instructions` MCP), ma prompt `automate_app`,
a w `.claude/skills/mpc-ekran/SKILL.md` jest skill z zasadami (patrz przed kliknięciem, nazywaj,
weryfikuj, zatrzymaj się na STOP, pytaj przed nieodwracalnym).

### 26 narzędzi

- **Obserwacja:** `screen_info`, `list_windows`, `focus_window`, `screenshot` (id `sN` + mapowanie obraz→ekran, siatka),
  `zoom` (ostre zbliżenie), `detect_elements` (strefy), `find_text` (OCR pl/en, tolerancja literówek)
- **Elementy:** `label_elements`, `list_elements`, `show_elements`, `locate_element`, `remove_element`, `use_profile`
- **Działanie:** `click` (z `verify`), `move_mouse`, `drag`, `scroll`, `type_text` (polskie litery), `press_keys`, `wait`
  (czas / napis / element / uspokojenie ekranu)
- **Sekwencje:** `sequence_record`, `sequence_save`, `sequence_list`, `sequence_run` (także próbnie), `sequence_delete`
- **Ustawienia:** `settings` (tryb próbny, rodzaj ruchu, tempo, szum, OCR)

Cel kliknięcia można podać jako: `element` (zapisany), `mark` + `shot` (numer strefy), `text` (napis na ekranie),
`x,y` + `shot` (piksele obrazu, który AI widziała) albo `x,y` + `space:"screen"`.

---

## MPC Studio

- **Pokaz** — stara i nowa wersja obok siebie, liczby zmierzone na tym komputerze (sekundy na element ręcznie,
  liczba stref w skanie), porównanie i scenariusz pokazu w 5 krokach.
- **AI na żywo** — oś czasu wywołań narzędzi, obraz, który AI właśnie dostała, postęp sekwencji, nagrywanie.
  „Pokazuj na ekranie” otwiera nakładkę: widać strefy, ścieżkę kursora i kliknięcia AI na prawdziwej aplikacji.
  Nakładka nie trafia na zrzuty AI (Windows `WDA_EXCLUDEFROMCAPTURE`).
- **Elementy** — wycinki ze stref, opisy (edycja w miejscu), „Pokaż na ekranie” (szuka po wyglądzie), filtr AI/człowiek/import.
- **Sekwencje** — kroki, zmienne, próba bez klikania, uruchomienie naprawdę, podświetlenie bieżącego kroku.
- **Ruchy myszy** — biblioteka nagranych ruchów (F8); klik start i cel na płótnie pokazuje, jak nagranie
  zostanie dopasowane do nowej drogi, obok krzywej syntetycznej.
- **Podłącz AI** — polecenia do skopiowania, polecenia startowe dla Claude, autotest, lista narzędzi.

Stara wersja w Studiu: **Zaznacz ręcznie** (przeciągasz prostokąt, nazywasz; licznik mierzy czas),
**Nagraj ruch myszy** (F8), **Nagraj sekwencję kliknięć** (F8, klikasz normalnie — każdy klik to krok
z wycinkiem, każdy dojazd to nowe nagranie ruchu; klawiatury nie nagrywa, żeby nie złapać haseł).

**Aplikacja ćwiczebna „Biuro Pomocy”** — formularz, menu, zakładki, lista, suwak. Bezpieczny cel na pokaz;
pasek stanu na dole pokazuje, co faktycznie zostało kliknięte.

### Scenariusz pokazu (ok. 10 min)

1. `START_STUDIO.cmd` → **Otwórz aplikację ćwiczebną**.
2. **Zaznacz ręcznie** 2–3 przyciski — publiczność widzi, ile to trwa (licznik sekund na element).
3. **Pokaż, jak widzi AI** — setki niebieskich stref w ~1,5 s; klik w strefę = nazwanie.
4. **Uruchom Claude z MCP** i wklej polecenie z zakładki „Podłącz AI” (wypełnij zgłoszenie, nagraj sekwencję).
   W Studiu zaznacz „pokazuj na ekranie” — widać, co AI wykrywa, nazywa i klika.
5. Przesuń okno Biura Pomocy i uruchom sekwencję w zakładce **Sekwencje** — elementy znajdą się po wyglądzie.

---

## Bezpieczeństwo

- **STOP:** przycisk w Studiu, klawisz **Pause** albo **Ctrl+Shift+F12** (gdy Studio działa), `node src/cli.js stop`.
  Blokada trwa do „Wznów” — AI nie może jej zdjąć sama.
- **Róg ekranu:** kursor w lewym górnym rogu = natychmiastowa pauza na 10 s.
- **Przejęcie myszy:** ruch myszą w trakcie ruchu AI (ponad 14 px) przerywa akcję.
- **Strażnik zasłonięcia:** cel należy do konkretnego okna (zrzut okna, element, szukanie w oknie). Jeśli w punkcie
  kliknięcia leży okno innej aplikacji, klik jest blokowany („Klik zablokowany…”) — sprawdzane przed ruchem
  i tuż przed wciśnięciem przycisku. Dodane po teście, w którym zasłonięte okno skończyło się klikiem w OBS.
- **Tryb próbny:** AI planuje i rysuje, ale nic nie klika (przełącznik w Studiu, `settings(dry_run=true)`).
- Instrukcja serwera każe AI pytać przed zakupami, płatnościami, wysyłką, usuwaniem i zmianą ustawień kont.
- Wszystko działa lokalnie. Zrzuty (`data/shots`) zostają na tym komputerze.

---

## Budowa

```
src/core/        win32.js (koffi: DPI, kursor, okna, SendInput, monitory)
                 capture.js (zrzuty nut-js, rejestr shotów i mapowanie)   image.js (sharp: skala, siatka, strefy)
                 detect/ uia.js · ocr.js (worker PowerShell: Windows.Media.Ocr + UIAutomation) · cv.js (piksele) · index.js (łączenie, numeracja)
                 match.js (NCC zgrubnie→dokładnie)   elements.js (profile, wzorce, odnajdywanie)
                 humanizer.js (nagrania + Fitts + Bézier)   input.js (mysz/klawiatura + bezpieczniki)
                 target.js · actions.js · sequences.js · recordings.js · settings.js · events.js · bocik.js
src/mcp/server.js   serwer MCP (stdio, oficjalne SDK)
src/studio/         Electron: main.js, index.html/studio.js/css, overlay.html/js, recorder.html, demo.html
data/               profiles/<profil>/elements.json + crops/, sequences/, recordings/, shots/, events.jsonl, settings.json
test/               unit.test.cjs, mcp-dry.test.cjs, live-demo.cjs (prawdziwa mysz na aplikacji ćwiczebnej)
```

Studio i serwer MCP to osobne procesy; rozmawiają przez `data/` (zdarzenia, ustawienia, STOP).
`MPC_DATA_DIR` przestawia katalog danych (testy używają osobnego), `MPC_DRY_RUN=1` wymusza tryb próbny.

## Ograniczenia

- Windows 10/11. Nakładka i zrzuty obejmują monitor główny (serwer widzi wszystkie monitory).
- Treść stron w Chrome/Edge/Brave zwykle nie jest wystawiona do UI Automation — wtedy działają OCR i piksele.
  Własne okna Studia wystawiają pełne drzewo (przełącznik `force-renderer-accessibility`).
- Gry i aplikacje z ochroną anty-cheat: nie używać.
- Odtworzenie sekwencji wymaga, żeby element wyglądał podobnie (próg dopasowania 0,8); po dużej zmianie wyglądu
  trzeba go nazwać ponownie.
