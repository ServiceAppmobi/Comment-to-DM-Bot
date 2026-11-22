# 📩 ServiceApp — Bot Comment-to-DM (Instagram & Facebook)

W pełni automatyczny, bezzależnościowy (czysty Python 3.9+) bot **Comment-to-DM** działający **24/7 w chmurze GitHub Actions** (identycznie jak `ServiceApp LatAm Lead Monitor`) dla **Instagrama** i **Facebooka**.

Gdy ktoś zostawi komentarz ze słowem kluczowym pod Twoim postem lub rolką (np. `APP`, `LINK`, `POBIERZ`, `QUERO`, `BAIXAR`, `DESCARGAR`), bot:
1. Automatycznie wysyła **prywatną wiadomość (DM)** z linkami do **ServiceApp** (poprzez oficjalne **Meta Private Replies API**).
2. Opcjonalnie dodaje **losową publiczną odpowiedź** pod komentarzem (*„Wysłane w wiadomości prywatnej! 📩”*), zwiększając zasięg posta i unikając flagi spamu.
3. Pilnuje **deduplikacji** w bazie SQLite (`comment_dm.db` zapisywanej w GitHub Actions Cache) — nigdy nie wyśle tej samej osobie dwóch DM pod jednym postem.
4. Publikuje czytelny raport w **GitHub Mobile (Summary)** oraz opcjonalnie wysyła powiadomienia na iPhone (**Resend E-mail**, **ntfy Push**, **Telegram**).

---

## ⚙️ Jak to działa na GitHubie (bez żadnego serwera)?

Workflow [.github/workflows/comment-to-dm-bot.yml](.github/workflows/comment-to-dm-bot.yml) uruchamia się automatycznie **co 10 minut** (`cron: '*/10 * * * *'`):
- Pobiera ostatnie posty/rolki z Instagrama i strony na Facebooku.
- Sprawdza nowe komentarze młodsze niż 6 dni (bezpiecznie wewnątrz 7-dniowego okna Meta Private Replies).
- Dopasowuje słowa kluczowe z pliku [rules.json](rules.json) (odporne na wielkość liter i polskie/portugalskie/hiszpańskie znaki diakrytyczne).
- Wysyła DM i publiczną odpowiedź, a następnie zapisuje stan bazy `comment_dm.db` w cache GitHub Actions.

---

## 🔑 Konfiguracja sekretów na GitHubie

W repozytorium GitHub przejdź do:
**Settings → Secrets and variables → Actions → New repository secret**

| Sekret | Wymagany? | Opis |
| --- | --- | --- |
| `META_ACCESS_TOKEN` | **Tak** | Długoterminowy Page Access Token / System User Token z Meta Business |
| `IG_USER_ID` | Dla IG | ID konta profesjonalnego Instagram (np. `178414...`) |
| `IG_USERNAME` | Opcjonalny | Login IG bez `@` (filtruje własne komentarze; bot wykrywa też sam z API) |
| `FB_PAGE_ID` | Dla FB | ID strony na Facebooku (Fanpage) |
| `FB_PAGE_ACCESS_TOKEN` | Opcjonalny | Osobny token dla FB Page (jeśli inny niż `META_ACCESS_TOKEN`) |
| `APP_NAME` | Opcjonalny | Domyślnie `ServiceApp` |
| `APP_URL` | Opcjonalny | Domyślnie `https://serviceapp.mobi` |
| `ANDROID_STORE_URL` | Opcjonalny | Link do Google Play |
| `IOS_STORE_URL` | Opcjonalny | Link do App Store |
| `RESEND_API_KEY` | Opcjonalny | Raporty e-mail przez Resend |
| `EMAIL_RECIPIENT` | Opcjonalny | Odbiorca raportów e-mail |
| `EMAIL_SENDER` | Opcjonalny | Nadawca e-mail |
| `NTFY_TOPIC` | Opcjonalny | Natywny Push na iPhone przez aplikację **ntfy** |
| `TELEGRAM_BOT_TOKEN` | Opcjonalny | Powiadomienia Telegram |
| `TELEGRAM_CHAT_ID` | Opcjonalny | ID czatu Telegram |
| `GEMINI_API_KEY` | Opcjonalny | Personalizacja treści DM przez Google Gemini (gdy `ai_personalize: true`) |

### Skąd wziąć `META_ACCESS_TOKEN`, `IG_USER_ID` i `FB_PAGE_ID`?
1. Upewnij się, że konto na Instagramie jest **Profesjonalne** (Firmowe lub Twórcy) i połączone ze stroną na Facebooku.
2. W aplikacji Instagram włącz: *Ustawienia → Wiadomości i odpowiedzi na relacje → Zarządzanie wiadomościami → Zezwalaj na dostęp do wiadomości*.
3. W [Meta for Developers](https://developers.facebook.com/) utwórz aplikację typu **Business** i dodaj uprawnienia:
   - Instagram: `instagram_basic`, `instagram_manage_comments`, `instagram_manage_messages`
   - Facebook: `pages_show_list`, `pages_read_engagement`, `pages_manage_metadata`, `pages_messaging`
4. W **Meta Business Settings → System Users** wygeneruj stały (nie wygasający) token z dostępem do Twojej strony FB i konta IG — wklej go jako `META_ACCESS_TOKEN`.
5. W [Graph API Explorer](https://developers.facebook.com/tools/explorer/) wywołaj:
   ```
   GET /me/accounts?fields=id,name,instagram_business_account
   ```
   - `id` → to Twoje `FB_PAGE_ID`
   - `instagram_business_account.id` → to Twoje `IG_USER_ID`
6. Po wpisaniu sekretów na GitHubie uruchom w zakładce **Actions** tryb **`test-meta`**, aby zweryfikować połączenie jednym kliknięciem.

---

## ✏️ Edycja słów kluczowych i wiadomości (nawet z iPhone'a)

Wszystkie kampanie, słowa kluczowe, treści DM i warianty publicznych odpowiedzi znajdują się w pliku **[rules.json](rules.json)**.
Możesz edytować ten plik bezpośrednio w przeglądarce lub aplikacji GitHub — zmiana zadziała automatycznie już przy kolejnym uruchomieniu co 10 minut.

Dostępne zmienne w szablonie `dm_text`:
- `{username}` – nazwa autora komentarza
- `{app_name}` – nazwa aplikacji (`ServiceApp`)
- `{app_url}` – główny link strony
- `{android_url}` – link Google Play
- `{ios_url}` – link App Store
- `{keyword}` – słowo kluczowe, które wyzwoliło bota

---

## 🚀 Uruchamianie lokalne i testy

```bash
# Testy jednostkowe i integracyjne
python3 -m unittest discover -s tests -v

# Symulacja pełnego cyklu na przykładowych komentarzach IG & FB (bez tokenów Meta)
python3 main.py --mock --dry-run

# Zapis wyników symulacji do lokalnej bazy i sprawdzenie statystyk
python3 main.py --mock
python3 main.py --stats

# Weryfikacja połączenia z Meta Graph API (po uzupełnieniu .env)
python3 main.py --test-meta

# Jednorazowy cykl produkcyjny
python3 main.py

# Opcjonalny serwer Webhook czasu rzeczywistego (jeśli kiedyś przeniesiesz na VPS/Railway)
python3 main.py --webhook-server
```
