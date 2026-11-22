# ServiceApp Social Bot — GitHub Edition (Instagram, Facebook & WhatsApp)

Kompletny bot i studio automatyzacji dla **ServiceApp** (**Comment-to-DM** + **Click-to-WhatsApp** + **strona pobierania aplikacji**), które działa w **100% na GitHub Pages i GitHub Actions** — **bez logowania do Facebooka i bez konta Meta for Developers**.

Cel główny bota: **zapraszanie użytkowników z Instagrama, Facebooka i WhatsAppa do pobrania i rejestracji w aplikacji ServiceApp** (Android Google Play, iPhone App Store, strona `serviceapp.mobi`).

---

## Co działa od razu bez integracji z Facebookiem?

1. **Smart Strona Pobierania ServiceApp + Click-to-WhatsApp (`whatsapp.html`) — 100% produkcyjne**
   - Jeden link na **Instagrama** (`whatsapp.html?src=instagram`), **Facebooka** (`whatsapp.html?src=facebook`) i **WhatsAppa** (`whatsapp.html?src=whatsapp`).
   - Automatycznie wykrywa telefon odwiedzającego (**Android → wyróżnia Google Play**, **iPhone → wyróżnia App Store**, **komputer → pokazuje kod QR**).
   - Dodaje parametry śledzenia kampanii (`referrer=utm_source=...` dla Google Play, `ct=...` dla App Store, `utm_source` dla WWW).
   - Zawiera gotowe przyciski **Click-to-WhatsApp (`wa.me`)**, które działają ze zwykłym numerem WhatsApp bez żadnego API Meta.
2. **Click-to-WhatsApp & ServiceApp Studio (`index.html`)**
   - Edycja linków **ServiceApp** (Web / Google Play / App Store) oraz numeru WhatsApp.
   - 1-klik kopiowania gotowych linków na **Instagrama**, **Facebooka** i **WhatsAppa**.
   - **Generator kodów QR 100% offline** (SVG i PNG) oraz **pływający widget HTML/JS** na dowolną stronę WWW.
3. **Prawdziwy Bot komentarzy w GitHub Actions (`.github/workflows/github-comment-bot.yml`)**
   - Reaguje na słowa kluczowe z `data/rules.json` (m.in. `APP`, `POBIERZ`, `SERVICEAPP`, `WHATSAPP`, a także PT-BR `BAIXAR` i ES-MX `DESCARGAR`) i automatycznie wysyła zaproszenie do pobrania ServiceApp + link `wa.me` (korzysta wyłącznie z wbudowanego `GITHUB_TOKEN`).
4. **Symulator Comment-to-DM (Instagram / Facebook / WhatsApp) + Mini-CRM Leadów**
   - Testowanie pełnego lejka (komentarz/wiadomość → odpowiedź publiczna → DM z linkami do Google Play, App Store i WhatsApp → kwalifikacja leada → eksport CSV pod Excela lub Webhook Discord/Slack/Make/n8n).

> **Uwaga techniczna:** Meta/Facebook nie pozwala na automatyczne wysyłanie prywatnych wiadomości DM na Instagramie/Facebooku bez tokenu z aplikacji Meta Developers. Ten projekt daje Ci w pełni działającą alternatywę na GitHubie (Click-to-WhatsApp + strona Link-in-Bio + GitHub Comment Bot + symulator i silnik `src/engine.js`, który w przyszłości można łatwo podpiąć pod API).

---

## Wdrożenie na GitHubie w 3 minuty

### 1. Wypchnij repozytorium na GitHub
```bash
git init
git add .
git commit -m "Initial commit: Social Bot Studio (GitHub Edition)"
git branch -M main
git remote add origin https://github.com/TWOJ_LOGIN/social-bot-github.git
git push -u origin main
```

### 2. Włącz GitHub Pages
1. Wejdź w swoje repozytorium na GitHubie → **Settings → Pages**.
2. W sekcji **Build and deployment → Source** wybierz **GitHub Actions**.
3. Workflow `.github/workflows/deploy-pages.yml` opublikuje automatycznie:
   - Panel główny: `https://TWOJ_LOGIN.github.io/social-bot-github/`
   - Publiczną stronę Click-to-WhatsApp (do bio): `https://TWOJ_LOGIN.github.io/social-bot-github/whatsapp.html`

### 3. Ustaw swój numer WhatsApp i reguły
- Edytuj bezpośrednio plik [`data/rules.json`](./data/rules.json) (pole `whatsapp.phone`) **lub** ustaw wszystko wygodnie w zakładce **Click-to-WhatsApp Studio**, kliknij **Pobierz rules.json** i podmień plik w repozytorium.
- Opcjonalnie dla bota GitHub Actions możesz ustawić w **Settings → Secrets and variables → Actions**:
  - Variable `WHATSAPP_PHONE` (np. `48500600700`) — nadpisuje numer telefonu dla bota.
  - Secret `OUTBOUND_WEBHOOK_URL` — opcjonalny webhook (Discord / Slack / Make / n8n) do powiadomień o leadach.

---

## Uruchomienie lokalne (opcjonalne, zero `npm install`)

Wymagany wyłącznie Node.js 20+ (projekt nie ma żadnych zewnętrznych paczek!):

```bash
# Uruchom lokalny serwer z zapisem data/rules.json i data/leads.json
npm start

# Uruchom testy jednostkowe
npm test

# Przetestuj bota GitHub Actions lokalnie (tryb dry-run)
BOT_DRY_RUN=1 COMMENT_AUTHOR=janek COMMENT_BODY="Poprosze CENNIK" node scripts/github-bot.mjs
```

---

## Struktura projektu

- `index.html` — Panel Social Bot Studio (Symulator, Click-to-WhatsApp Studio, Reguły, Leady, Instrukcja GitHub)
- `whatsapp.html` — Gotowa, publiczna strona Click-to-WhatsApp / Link-in-Bio
- `data/rules.json` — Centralna konfiguracja numeru WhatsApp, marki i reguł słów kluczowych
- `src/engine.js` — Wspólny silnik dopasowania reguł, anty-spamu, linków `wa.me` i eksportu CSV
- `src/qr.js` — Czysty generator kodów QR (ISO/IEC 18004, SVG/PNG, 100% offline)
- `src/widget-generator.js` — Generator pływającego widgetu HTML/JS Click-to-WhatsApp
- `scripts/github-bot.mjs` — Skrypt bota komentarzy uruchamiany przez GitHub Actions
- `server.mjs` — Opcjonalny lokalny serwer Node.js (zero zależności)
- `.github/workflows/` — Gotowe workflow: `deploy-pages.yml`, `github-comment-bot.yml`, `ci.yml`
