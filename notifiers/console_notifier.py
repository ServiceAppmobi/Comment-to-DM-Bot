from typing import Any, Dict


class ConsoleNotifier:
    """Czytelny podgląd zdarzeń Comment-to-DM w logach konsoli i GitHub Actions."""

    @staticmethod
    def print_event(event: Dict[str, Any]) -> None:
        platform = "📸 Instagram" if event.get("platform") == "instagram" else "📘 Facebook"
        status = event.get("status", "UNKNOWN")
        print("=" * 72)
        print(f"[{platform}] Status: {status} | Reguła: {event.get('rule_name', '-')}")
        print(f"Autor:    @{event.get('author_username', 'unknown')} | Słowo: {event.get('matched_keyword', '-')}")
        print(f"Komentarz:{' '}{event.get('comment_text', '')}")
        if event.get("post_url"):
            print(f"Post:     {event.get('post_url')}")
        if event.get("dm_text"):
            preview = event["dm_text"].replace("\n", " ")[:180]
            print(f"DM:       {preview}...")
        if event.get("public_reply_text"):
            print(f"Odpowiedź:{' '}{event.get('public_reply_text')}")
        if event.get("error_message"):
            print(f"Błąd:     {event.get('error_message')}")
        print("=" * 72)
