#!/usr/bin/env python3
"""
ServiceApp — Bot Comment-to-DM (Instagram & Facebook)
=====================================================
Automatycznie skanuje komentarze pod postami i rolkami na Instagramie oraz Facebooku,
dopasowuje słowa kluczowe z pliku rules.json i wysyła prywatne wiadomości (Private Reply DM)
oraz losowe publiczne odpowiedzi pod komentarzami.

Zaprojektowany do 100% automatycznego działania w GitHub Actions (harmonogram cron)
z synchronizacją raportów na iPhone (GitHub Mobile, Resend E-mail, ntfy Push, Telegram).
"""

import argparse
import os
import sys
from datetime import datetime, timezone


def load_env_file() -> None:
    """Ładuje zmienne z lokalnego .env (nie nadpisuje zmiennych z GitHub Secrets)."""
    env_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
    if os.path.exists(env_path):
        with open(env_path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    key, val = line.split("=", 1)
                    os.environ.setdefault(key.strip(), val.strip().strip('"').strip("'"))


load_env_file()

from config import (
    APP_NAME,
    DRY_RUN_DEFAULT,
    EMAIL_RECIPIENT,
    EMAIL_SENDER,
    FACEBOOK_ENABLED,
    INSTAGRAM_ENABLED,
)
from database import get_stats, init_db
from engine import process_comments
from matcher import load_rules
from meta_client import MetaApiError, MetaGraphClient
from notifiers.email_notifier import EmailNotifier
from notifiers.ntfy_notifier import NtfyNotifier
from notifiers.telegram_notifier import TelegramNotifier


def write_github_summary(result: dict, mode_label: str) -> None:
    """Zapisuje czytelny raport Markdown do $GITHUB_STEP_SUMMARY (widoczny na iPhone w GitHub Mobile)."""
    summary_path = os.getenv("GITHUB_STEP_SUMMARY")
    if not summary_path:
        return

    st = result["stats"]
    sent_events = result["sent_events"]
    error_events = result["error_events"]

    lines = [
        f"# 📩 {APP_NAME} Comment-to-DM Bot — Raport ({mode_label})",
        "",
        f"- **Data (UTC):** {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}",
        f"- **Przeskanowano komentarzy:** {st['scanned']}",
        f"- **Wysłane DM:** **{st['dm_sent']}** | **Publiczne odpowiedzi:** {st['public_replies_sent']}",
        f"- **Pominięte:** już przetworzone: {st['already_processed']} | brak słowa kluczowego: {st['no_match']} | duplikat użytkownika: {st['duplicate_user']} | starsze niż okno 7 dni: {st['expired']}",
        f"- **Błędy API:** {st['errors']}",
        "",
    ]

    if sent_events:
        lines.extend(
            [
                "## ✅ Obsłużone komentarze",
                "",
                "| Platforma | Autor | Słowo | Komentarz | Status |",
                "| --- | --- | --- | --- | --- |",
            ]
        )
        for ev in sent_events:
            plat = "📸 IG" if ev.get("platform") == "instagram" else "📘 FB"
            comment_clean = str(ev.get("comment_text", "")).replace("|", "\\|").replace("\n", " ")[:100]
            lines.append(
                f"| {plat} | `@{ev.get('author_username', '')}` | `{ev.get('matched_keyword', '')}` | {comment_clean} | `{ev.get('status', '')}` |"
            )
        lines.append("")
    else:
        lines.append("_Brak nowych pasujących komentarzy w tym cyklu._\n")

    if error_events:
        lines.extend(["## ⚠️ Błędy podczas wysyłki", ""])
        for err in error_events:
            lines.append(
                f"- **[{err.get('platform')}]** `@{err.get('author_username')}` (`{err.get('comment_id')}`): `{err.get('error_message')}`"
            )
        lines.append("")

    try:
        with open(summary_path, "a", encoding="utf-8") as f:
            f.write("\n".join(lines) + "\n")
    except Exception as e:
        print(f"[!] Nie udało się zapisać GITHUB_STEP_SUMMARY: {e}")


def run_cycle(mock: bool = False, dry_run: bool = False) -> int:
    mode_label = "MOCK" if mock else ("DRY-RUN" if dry_run else "LIVE")
    print(
        f"\n[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] "
        f"📩 Start cyklu {APP_NAME} Comment-to-DM (tryb: {mode_label})..."
    )

    init_db()
    rules = load_rules()
    print(f"[*] Załadowano aktywnych reguł z rules.json: {len(rules)}")

    meta_client = MetaGraphClient()
    emailer = EmailNotifier()
    ntfy = NtfyNotifier()
    telegram = TelegramNotifier()

    comments = []
    if mock:
        print("[i] Tryb demonstracyjny (--mock): pobieranie przykładowych komentarzy IG & FB...")
        comments = MetaGraphClient.get_mock_comments()
    else:
        any_configured = False

        if INSTAGRAM_ENABLED and meta_client.is_instagram_configured():
            any_configured = True
            print("[*] Pobieranie komentarzy z Instagrama (posty i rolki)...")
            try:
                ig_comments = meta_client.fetch_instagram_comments()
                print(f"    -> Pobrano {len(ig_comments)} komentarzy z Instagrama")
                comments.extend(ig_comments)
            except MetaApiError as e:
                print(f"[!] Błąd pobierania z Instagrama (kod {e.error_code}): {e}")
        else:
            print("[i] Instagram: pominięto (brak IG_USER_ID / META_ACCESS_TOKEN lub wyłączony).")

        if FACEBOOK_ENABLED and meta_client.is_facebook_configured():
            any_configured = True
            print("[*] Pobieranie komentarzy ze strony na Facebooku...")
            try:
                fb_comments = meta_client.fetch_facebook_comments()
                print(f"    -> Pobrano {len(fb_comments)} komentarzy z Facebooka")
                comments.extend(fb_comments)
            except MetaApiError as e:
                print(f"[!] Błąd pobierania z Facebooka (kod {e.error_code}): {e}")
        else:
            print("[i] Facebook: pominięto (brak FB_PAGE_ID / META_ACCESS_TOKEN lub wyłączony).")

        if not any_configured:
            print("\n[!] Nie skonfigurowano jeszcze żadnej platformy Meta!")
            print("    Dodaj sekrety META_ACCESS_TOKEN oraz IG_USER_ID i/lub FB_PAGE_ID")
            print("    w GitHub Secrets (Settings -> Secrets and variables -> Actions) lub lokalnym .env.")
            print("    Aby przetestować bota bez tokenów Meta, uruchom: python3 main.py --mock")

    result = process_comments(
        comments,
        rules,
        meta_client,
        mock=mock,
        dry_run=dry_run,
        ntfy=ntfy if not mock else None,
        telegram=telegram if not mock else None,
    )

    write_github_summary(result, mode_label)

    # Zbiorczy raport e-mail po wysłaniu nowych DM
    if result["sent_events"] and not dry_run and not mock:
        if emailer.is_configured():
            print(f"[*] Wysyłam raport e-mail na {EMAIL_RECIPIENT}...")
            emailer.send_digest_email(result["sent_events"])

    st = result["stats"]
    print("\n[✓] Zakończono cykl Comment-to-DM.")
    print(f"    - Przeskanowano komentarzy:   {st['scanned']}")
    print(f"    - Wysłano DM:                 {st['dm_sent']}")
    print(f"    - Publicznych odpowiedzi:     {st['public_replies_sent']}")
    print(f"    - Pominiętych (duplikaty/stare/inne): {st['already_processed'] + st['duplicate_user'] + st['expired'] + st['no_match']}")
    print(f"    - Błędów API:                 {st['errors']}")
    return 0


def main() -> None:
    parser = argparse.ArgumentParser(
        description="ServiceApp Comment-to-DM Bot (Instagram & Facebook + GitHub Actions)"
    )
    parser.add_argument(
        "--mock",
        action="store_true",
        help="Tryb demonstracyjny z przykładowymi komentarzami IG & FB (bez wywołań Meta API)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Skanuje i dopasowuje komentarze bez wysyłania prawdziwych DM ani zapisu do bazy",
    )
    parser.add_argument(
        "--test-meta",
        action="store_true",
        help="Weryfikuje tokeny Meta Graph API dla Instagrama i Facebooka",
    )
    parser.add_argument(
        "--test-email",
        action="store_true",
        help="Wysyła testowy raport e-mail przez Resend/SMTP",
    )
    parser.add_argument(
        "--test-push",
        action="store_true",
        help="Wysyła testowe powiadomienie Push (ntfy) na iPhone",
    )
    parser.add_argument(
        "--stats",
        action="store_true",
        help="Wyświetla zbiorcze statystyki wysłanych DM z bazy SQLite",
    )
    parser.add_argument(
        "--webhook-server",
        action="store_true",
        help="Uruchamia serwer HTTP Webhook (opcjonalny tryb czasu rzeczywistego poza GitHub Actions)",
    )

    args = parser.parse_args()
    effective_dry_run = args.dry_run or DRY_RUN_DEFAULT

    if args.stats:
        init_db()
        s = get_stats()
        print(f"\n📊 STATYSTYKI {APP_NAME.upper()} COMMENT-TO-DM:")
        print(f"  • Wszystkich przetworzonych komentarzy: {s['total_processed']}")
        print(f"  • Wysłane DM (produkcja):               {s['dm_sent']}")
        print(f"  • Wysłane DM (symulacja mock):          {s['dm_sent_mock']}")
        print(f"  • 📸 Instagram DM łącznie:              {s['instagram_dm_sent']}")
        print(f"  • 📘 Facebook DM łącznie:               {s['facebook_dm_sent']}")
        print(f"  • Publicznych odpowiedzi w komentarzach:{s['public_replies_sent']}")
        print(f"  • Pominięte (brak słowa kluczowego):    {s['skipped_no_match']}")
        print(f"  • Pominięte (duplikat użytkownika):     {s['skipped_duplicate_user']}")
        print(f"  • Pominięte (starsze niż okno 7 dni):   {s['skipped_expired']}")
        print(f"  • Błędy API:                            {s['errors']}")
        return

    if args.test_meta:
        client = MetaGraphClient()
        res = client.verify_credentials()
        print("\n🔌 WERYFIKACJA POŁĄCZENIA Z META GRAPH API:")
        all_ok = False
        for plat in ("instagram", "facebook"):
            info = res[plat]
            if not info["configured"]:
                print(f"  • {plat.upper()}: nie skonfigurowano (brak ID lub tokenu)")
            elif info["ok"]:
                all_ok = True
                details = info.get("account") or info.get("page") or {}
                print(f"  • {plat.upper()}: ✅ OK -> {details}")
            else:
                print(f"  • {plat.upper()}: ❌ BŁĄD (kod {info.get('error_code')}): {info.get('error')}")
        if not all_ok:
            sys.exit(1)
        return

    if args.test_email:
        emailer = EmailNotifier()
        if not emailer.is_configured():
            print("[!] Brak konfiguracji RESEND_API_KEY lub SMTP_PASSWORD.")
            sys.exit(1)
        print(f"[*] Wysyłam testowy e-mail z {EMAIL_SENDER} na {EMAIL_RECIPIENT}...")
        if emailer.send_test_email():
            print("[✓] Sukces! Sprawdź skrzynkę odbiorczą.")
        else:
            print("[!] Nie udało się wysłać e-maila.")
            sys.exit(1)
        return

    if args.test_push:
        ntfy = NtfyNotifier()
        if not ntfy.is_configured():
            print("[!] Brak konfiguracji NTFY_TOPIC.")
            sys.exit(1)
        if ntfy.send_test_push():
            print("[✓] Wysłano testowe powiadomienie Push (ntfy)!")
        else:
            print("[!] Nie udało się wysłać powiadomienia Push.")
            sys.exit(1)
        return

    if args.webhook_server:
        from webhook_server import run_webhook_server

        run_webhook_server(dry_run=effective_dry_run)
        return

    code = run_cycle(mock=args.mock, dry_run=effective_dry_run)
    sys.exit(code)


if __name__ == "__main__":
    main()
