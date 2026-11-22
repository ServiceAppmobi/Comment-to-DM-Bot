import hashlib
import hmac
import json
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, List

from config import (
    FB_PAGE_ID,
    IG_USER_ID,
    IG_USERNAME,
    META_APP_SECRET,
    META_VERIFY_TOKEN,
    WEBHOOK_HOST,
    WEBHOOK_PORT,
)
from database import init_db
from engine import process_comments
from matcher import load_rules
from meta_client import MetaGraphClient
from notifiers.ntfy_notifier import NtfyNotifier
from notifiers.telegram_notifier import TelegramNotifier


def verify_meta_signature(raw_body: bytes, signature_header: str, app_secret: str = META_APP_SECRET) -> bool:
    """Weryfikuje podpis X-Hub-Signature-256 wysyłany przez Meta Webhooks."""
    if not app_secret:
        return True
    if not signature_header or not signature_header.startswith("sha256="):
        return False
    expected = "sha256=" + hmac.new(
        app_secret.encode("utf-8"),
        raw_body,
        hashlib.sha256,
    ).hexdigest()
    return hmac.compare_digest(expected, signature_header.strip())


def parse_webhook_payload(payload: Dict[str, Any]) -> List[Dict[str, Any]]:
    """
    Konwertuje payload z Meta Webhook (Instagram 'comments' oraz Facebook 'feed')
    do ujednoliconego formatu komentarzy rozumianego przez engine.process_comments().
    """
    comments: List[Dict[str, Any]] = []
    obj_type = str(payload.get("object") or "").lower()

    for entry in payload.get("entry") or []:
        for change in entry.get("changes") or []:
            field = str(change.get("field") or "").lower()
            val = change.get("value") or {}

            if obj_type == "instagram" and field == "comments":
                from_obj = val.get("from") or {}
                author_id = str(from_obj.get("id") or "")
                author_username = str(from_obj.get("username") or "").lstrip("@")
                if (IG_USER_ID and author_id == IG_USER_ID) or (
                    IG_USERNAME and author_username.lower() == IG_USERNAME
                ):
                    continue
                media_obj = val.get("media") or {}
                comment_id = str(val.get("id") or "")
                post_id = str(media_obj.get("id") or "")
                text = str(val.get("text") or "")
                if comment_id and post_id and text:
                    comments.append(
                        {
                            "platform": "instagram",
                            "comment_id": comment_id,
                            "post_id": post_id,
                            "post_url": "",
                            "author_id": author_id,
                            "author_username": author_username or "użytkownik",
                            "text": text,
                            "timestamp": None,
                        }
                    )

            elif obj_type == "page" and field == "feed":
                if val.get("item") != "comment" or val.get("verb") != "add":
                    continue
                from_obj = val.get("from") or {}
                author_id = str(from_obj.get("id") or "")
                author_name = str(from_obj.get("name") or "użytkownik")
                if FB_PAGE_ID and author_id == FB_PAGE_ID:
                    continue
                comment_id = str(val.get("comment_id") or "")
                post_id = str(val.get("post_id") or "")
                text = str(val.get("message") or "")
                if comment_id and post_id and text:
                    comments.append(
                        {
                            "platform": "facebook",
                            "comment_id": comment_id,
                            "post_id": post_id,
                            "post_url": "",
                            "author_id": author_id,
                            "author_username": author_name,
                            "text": text,
                            "timestamp": None,
                        }
                    )

    return comments


def run_webhook_server(dry_run: bool = False) -> None:
    """Uruchamia lekki serwer HTTP nasłuchujący na żywo webhooki Instagram & Facebook."""
    init_db()
    meta_client = MetaGraphClient()
    ntfy = NtfyNotifier()
    telegram = TelegramNotifier()

    class WebhookHandler(BaseHTTPRequestHandler):
        def log_message(self, fmt: str, *args) -> None:
            print(f"[Webhook] {self.address_string()} - {fmt % args}")

        def do_GET(self) -> None:
            parsed = urllib.parse.urlparse(self.path)
            if parsed.path == "/health":
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(b'{"status":"ok"}')
                return

            if parsed.path != "/webhook":
                self.send_response(404)
                self.end_headers()
                return

            qs = urllib.parse.parse_qs(parsed.query)
            mode = (qs.get("hub.mode") or [""])[0]
            token = (qs.get("hub.verify_token") or [""])[0]
            challenge = (qs.get("hub.challenge") or [""])[0]

            if mode == "subscribe" and token == META_VERIFY_TOKEN:
                self.send_response(200)
                self.send_header("Content-Type", "text/plain")
                self.end_headers()
                self.wfile.write(challenge.encode("utf-8"))
                print("[✓] Webhook Meta zweryfikowany pomyślnie!")
            else:
                self.send_response(403)
                self.end_headers()

        def do_POST(self) -> None:
            parsed = urllib.parse.urlparse(self.path)
            if parsed.path != "/webhook":
                self.send_response(404)
                self.end_headers()
                return

            content_len = int(self.headers.get("Content-Length", "0"))
            raw_body = self.rfile.read(content_len)
            sig = self.headers.get("X-Hub-Signature-256", "")

            if not verify_meta_signature(raw_body, sig):
                print("[!] Odrzucono żądanie: nieprawidłowy podpis X-Hub-Signature-256")
                self.send_response(401)
                self.end_headers()
                return

            try:
                payload = json.loads(raw_body.decode("utf-8"))
            except json.JSONDecodeError:
                self.send_response(400)
                self.end_headers()
                return

            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"received":true}')

            comments = parse_webhook_payload(payload)
            if comments:
                rules = load_rules()
                process_comments(
                    comments,
                    rules,
                    meta_client,
                    dry_run=dry_run,
                    ntfy=ntfy,
                    telegram=telegram,
                )

    server = ThreadingHTTPServer((WEBHOOK_HOST, WEBHOOK_PORT), WebhookHandler)
    print(f"🚀 Serwer Webhook Comment-to-DM nasłuchuje na http://{WEBHOOK_HOST}:{WEBHOOK_PORT}/webhook")
    print("   Healthcheck: /health | Weryfikacja Meta: GET /webhook | Zdarzenia: POST /webhook")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[i] Zatrzymywanie serwera Webhook...")
        server.server_close()
