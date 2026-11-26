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
app(action="open", window="MetaTrader")   tekstowa mapa aplikacji (elementy, ekrany, przepisy, lekcje, wiedza)
                                          — kilkaset tokenów zamiast zrzutu za ~1500; przy pierwszej wizycie tworzy profil
  → jest przepis?       sequence_run("zlecenie_kupna", variables={lot:"0.1"})   (najpierw dry_run, gdy niepewnie)
  → jest lekcja?        lesson(action="get") → lesson(action="to_sequence") → poprawki → uruchomienie
  → inaczej uczy się:
focus_window("MetaTrader") → detect_elements(window=…, image=false)   sama lista, gdy obraz niepotrzebny
label_elements(shot, items=[{mark:13, name:"pole_wolumen"}, …])
act(steps=[{action:"click", element:"…"}, {action:"type", element:"…", text:"0.1", clear:true}, …])   wiele kroków, jedno wywołanie
sequence_save(name, goal, steps, variables) → app(action="note", text="F9 otwiera okno zlecenia…")
```

Serwer wysyła przy połączeniu instrukcję pracy (pole `instructions` MCP), ma prompty `automate_app` i `learn_app`,
a w `.claude/skills/mpc-ekran/SKILL.md` jest skill z zasadami (najpierw pamięć aplikacji, patrz przed kliknięciem,
nazywaj, weryfikuj, zatrzymaj się na STOP, pytaj przed nieodwracalnym — także przed zleceniem na giełdzie).

Nie trzeba osobnego MCP do każdej aplikacji (np. MetaTrader 5): pamięć jest per aplikacja i rośnie z każdą
wizytą — elementy, ekrany, przepisy i notatki AI w `data/profiles/<aplikacja>/`.

### 29 narzędzi

- **Obserwacja:** `screen_info`, `list_windows`, `focus_window`, `screenshot` (id `sN` + mapowanie obraz→ekran, siatka),
  `zoom` (ostre zbliżenie), `detect_elements` (strefy; `image=false` = sama lista), `find_text` (OCR pl/en, literówki)
- **Elementy:** `label_elements`, `list_elements`, `show_elements`, `locate_element`,
  `edit_element` (usuń / zmień nazwę / popraw strefę, kategorię, „ważny”), `use_profile`
- **Pamięć aplikacji i nauka:** `app` (open / list / knowledge / note / screen), `lesson` (lekcje człowieka:
  list / get z obrazami kroków / to_sequence)
- **Działanie:** `click` (z `verify`, `screenshot_after`), `move_mouse`, `drag`, `scroll`, `type_text` (polskie litery),
  `press_keys`, `wait` (czas / napis / element / uspokojenie ekranu), `act` (wiele kroków w jednym wywołaniu)
- **Sekwencje (przepisy):** `sequence_record`, `sequence_save` (z celem), `sequence_list`, `sequence_run` (także próbnie),
  `sequence_delete`
- **Ustawienia:** `settings` (tryb próbny, rodzaj ruchu, tempo, szum, OCR)

Cel kliknięcia można podać jako: `element` (zapisany), `mark` + `shot` (numer strefy), `text` (napis na ekranie),
`x,y` + `shot` (piksele obrazu, który AI widziała) albo `x,y` + `space:"screen"`.

---

## Nauka aplikacji — lekcje człowieka (Studio → Nauka)

1. Wpisz cel lekcji (np. „wystawić zlecenie kupna EURUSD z lotem {{lot}}”), wciśnij **F9** (skrót do zmiany)
   albo **Start nagrywania**. Studio chowa się, w rogu pojawia się pasek nagrywania.
2. Klikaj normalnie w dowolnych programach. Każdy klik:
   - zapisuje krok i zrzut okna z chwili wciśnięcia (zanim UI zareaguje),
   - **mapuje kliknięty element lokalnie, bez AI**: UI Automation (nazwa, typ, AutomationId) → piksele → OCR napisu;
     klik w napis przy checkboxie/radiu trafia w samą kontrolkę,
   - nadaje nazwę i **kolor wg typu**: przycisk niebieski, pole tekstowe zielone, wybór/lista fioletowy,
     menu/zakładka pomarańczowy, link turkusowy, inne różowe — strefa od razu świeci na ekranie i jedzie za oknem,
   - zapisuje drogę myszy od poprzedniego kliku jako **próbkę ruchu** (z nich AI potem jeździ kursorem),
   - przy nowym ekranie mapuje **wszystkie** jego strefy (AI dostaje mapę, nie tylko kliknięte przyciski).
3. Wpisywany tekst i skróty (Enter, Ctrl+S…) też trafiają do lekcji; hasła są ukryte jako `{{haslo}}`.
4. **F9** kończy. W edytorze lekcji: kroki z obrazami, przeciąganie i zmiana rozmiaru strefy, nazwa, kategoria,
   „ważny” — poprawka od razu aktualizuje element i jego wzorzec.
5. **Zrób przepis** — lekcja → sekwencja ze zmiennymi (`{{tekst}}`, `{{haslo}}`), oczekiwaniem na wolne ekrany
   i fokusem okna. **Naucz AI z tej lekcji** / **AI uczy się sama** — Studio zapisuje plik zadania z celem,
   mapą aplikacji i lekcjami i otwiera terminal z Claude, który przez MCP sam dochodzi do celu
   (dry-run, nazywa elementy, zapisuje przepis i notatki — nie tylko odtwarza kliknięcia).

**Odporność:** element pamięta pozycję względem okna z kotwicą (lewa/prawa/proporcjonalnie, góra/dół), skalę DPI
okna i tożsamość UI Automation. Szukanie: miejsce oczekiwane → UIA (AutomationId/nazwa) → wzorzec w oknie →
cały ekran. Strefy nakładki co 150 ms podążają za prostokątem okna — po przesunięciu, zmianie rozmiaru
albo przełączeniu aplikacji nie zostają w starym miejscu.

## MPC Studio

- **Nauka** — nagrywanie lekcji (wyżej), lista lekcji, edytor stref, „AI uczy się sama”, podgląd mapy dla AI.
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
                 categories.js (typ → kolor, nazwy)   apps.js (rozpoznanie aplikacji, ekrany, wiedza, mapa tekstowa)
                 lessons.js (lekcje, analiza kliku, lekcja → przepis)
src/mcp/server.js   serwer MCP (stdio, oficjalne SDK)
src/studio/         Electron: main.js, index.html/studio.js/css, overlay.html/js, recorder.html, demo.html,
                    lesson-recorder.js (nagrywanie lekcji: mysz, klawiatura, mapowanie)
data/               profiles/<aplikacja>/ elements.json + crops/ + screens/ + wiedza.md, lessons/<lekcja>/ lesson.json + step-NNN.png,
                    learn/ (zadania dla AI), sequences/, recordings/, shots/, events.jsonl, settings.json
test/               unit.test.cjs, learn.test.cjs, mcp-dry.test.cjs, live-demo.cjs (prawdziwa mysz na aplikacji ćwiczebnej)
```

Studio i serwer MCP to osobne procesy; rozmawiają przez `data/` (zdarzenia, ustawienia, STOP).
`MPC_DATA_DIR` przestawia katalog danych (testy używają osobnego), `MPC_DRY_RUN=1` wymusza tryb próbny.

## Ograniczenia

- Windows 10/11. Nakładka i zrzuty obejmują monitor główny (serwer widzi wszystkie monitory).
- Treść stron w Chrome/Edge/Brave zwykle nie jest wystawiona do UI Automation — wtedy działają OCR i piksele.
  Własne okna Studia wystawiają pełne drzewo (przełącznik `force-renderer-accessibility`).
- Gry i aplikacje z ochroną anty-cheat: nie używać.
- Odtworzenie sekwencji wymaga, żeby element wyglądał podobnie (próg dopasowania 0,8); po dużej zmianie wyglądu
  trzeba go nazwać ponownie (UIA ratuje elementy z AutomationId).
- Nagrywanie klawiatury czyta stan klawiszy (bez haka systemowego): tekst wklejony schowkiem albo wpisany
  przez inny program jako znaki Unicode nie trafia do lekcji jako tekst.
- Bez UI Automation (gry, własne rysowanie, część stron) typ elementu zgaduje analiza pikseli — sprawdź kolor
  strefy w edytorze lekcji i popraw, jeśli trzeba.
