import json
import urllib.request
from typing import Any, Dict
from config import APP_NAME, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID


class TelegramNotifier:
    """Opcjonalne powiadomienia Telegram o wysłanych DM."""

    def __init__(self, token: str = TELEGRAM_BOT_TOKEN, chat_id: str = TELEGRAM_CHAT_ID):
        self.token = token.strip()
        self.chat_id = chat_id.strip()

    def is_configured(self) -> bool:
        return bool(self.token and self.chat_id)

    def send_message(self, text: str) -> bool:
        if not self.is_configured():
            return False
        url = f"https://api.telegram.org/bot{self.token}/sendMessage"
        payload = {
            "chat_id": self.chat_id,
            "text": text,
            "disable_web_page_preview": True,
        }
        req = urllib.request.Request(
            url,
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                return resp.status == 200
        except Exception as e:
            print(f"[!] Błąd wysyłania powiadomienia Telegram: {e}")
            return False

    def notify_dm_sent(self, event: Dict[str, Any]) -> bool:
        plat = "📸 Instagram" if event.get("platform") == "instagram" else "📘 Facebook"
        text = (
            f"📩 {APP_NAME} Comment-to-DM ({plat})\n"
            f"Autor: @{event.get('author_username', '')}\n"
            f"Słowo: {event.get('matched_keyword', '')}\n"
            f"Komentarz: {event.get('comment_text', '')[:200]}\n"
            f"Post: {event.get('post_url', '-')}"
        )
        return self.send_message(text)
