import html
import json
import smtplib
import urllib.error
import urllib.request
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from typing import Any, Dict, List
from config import (
    APP_NAME,
    EMAIL_RECIPIENT,
    EMAIL_SENDER,
    RESEND_API_KEY,
    SMTP_HOST,
    SMTP_PASSWORD,
    SMTP_PORT,
    SMTP_USE_TLS,
    SMTP_USER,
)


class EmailNotifier:
    """Wysyła zbiorcze raporty HTML o wysłanych DM przez Resend API (lub fallback SMTP)."""

    def __init__(self):
        self.resend_key = RESEND_API_KEY
        self.sender = EMAIL_SENDER
        self.recipient = EMAIL_RECIPIENT

    def is_configured(self) -> bool:
        return bool(self.recipient and (self.resend_key or SMTP_PASSWORD))

    def _send_via_resend(self, subject: str, html_body: str, text_body: str) -> bool:
        payload = {
            "from": f"{APP_NAME} Comment-to-DM Bot <{self.sender}>",
            "to": [self.recipient],
            "subject": subject,
            "html": html_body,
            "text": text_body,
        }
        req = urllib.request.Request(
            "https://api.resend.com/emails",
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {self.resend_key}",
                "Content-Type": "application/json",
                "User-Agent": "ServiceAppCommentToDMBot/1.0",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                return resp.status in (200, 201)
        except urllib.error.HTTPError as e:
            err = e.read().decode("utf-8", errors="replace")
            print(f"[!] Błąd Resend API ({e.code}): {err}")
            return False
        except Exception as e:
            print(f"[!] Błąd połączenia z Resend API: {e}")
            return False

    def _send_via_smtp(self, subject: str, html_body: str, text_body: str) -> bool:
        msg = MIMEMultipart("alternative")
        msg["Subject"] = subject
        msg["From"] = self.sender
        msg["To"] = self.recipient
        msg.attach(MIMEText(text_body, "plain", "utf-8"))
        msg.attach(MIMEText(html_body, "html", "utf-8"))
        try:
            if SMTP_PORT == 465:
                server = smtplib.SMTP_SSL(SMTP_HOST, SMTP_PORT, timeout=15)
            else:
                server = smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=15)
                if SMTP_USE_TLS:
                    server.starttls()
            with server:
                server.login(SMTP_USER, SMTP_PASSWORD)
                server.sendmail(self.sender, [self.recipient], msg.as_string())
            return True
        except Exception as e:
            print(f"[!] Błąd wysyłki SMTP: {e}")
            return False

    def send_email(self, subject: str, html_body: str, text_body: str) -> bool:
        if not self.is_configured():
            return False
        if self.resend_key:
            return self._send_via_resend(subject, html_body, text_body)
        return self._send_via_smtp(subject, html_body, text_body)

    def send_digest_email(self, events: List[Dict[str, Any]]) -> bool:
        if not events:
            return False

        ig_cnt = sum(1 for e in events if e.get("platform") == "instagram")
        fb_cnt = sum(1 for e in events if e.get("platform") == "facebook")
        subject = f"📩 {APP_NAME} Comment-to-DM: wysłano {len(events)} DM (IG: {ig_cnt}, FB: {fb_cnt})"

        rows_html = []
        lines_text = [subject, ""]
        for ev in events:
            plat = "Instagram" if ev.get("platform") == "instagram" else "Facebook"
            user = html.escape(str(ev.get("author_username", "")))
            comment = html.escape(str(ev.get("comment_text", "")))
            kw = html.escape(str(ev.get("matched_keyword", "")))
            status = html.escape(str(ev.get("status", "")))
            url = html.escape(str(ev.get("post_url", "")))
            link_html = f'<a href="{url}">Zobacz post</a>' if url else "-"
            rows_html.append(
                f"<tr>"
                f"<td style='padding:8px;border-bottom:1px solid #eee;'><b>{plat}</b></td>"
                f"<td style='padding:8px;border-bottom:1px solid #eee;'>@{user}</td>"
                f"<td style='padding:8px;border-bottom:1px solid #eee;'>{comment}</td>"
                f"<td style='padding:8px;border-bottom:1px solid #eee;'><code>{kw}</code></td>"
                f"<td style='padding:8px;border-bottom:1px solid #eee;'>{status}</td>"
                f"<td style='padding:8px;border-bottom:1px solid #eee;'>{link_html}</td>"
                f"</tr>"
            )
            lines_text.append(
                f"- [{plat}] @{ev.get('author_username')} ({ev.get('matched_keyword')}): "
                f"{ev.get('comment_text')} -> {ev.get('status')} {ev.get('post_url', '')}"
            )

        html_body = f"""
        <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:720px;margin:0 auto;color:#111;">
            <h2>📩 {html.escape(APP_NAME)} — Raport bota Comment-to-DM</h2>
            <p>Wysłano <b>{len(events)}</b> prywatnych wiadomości (📸 Instagram: {ig_cnt}, 📘 Facebook: {fb_cnt}).</p>
            <table style="width:100%;border-collapse:collapse;font-size:14px;">
                <thead>
                    <tr style="background:#f5f7fa;text-align:left;">
                        <th style="padding:8px;">Platforma</th>
                        <th style="padding:8px;">Użytkownik</th>
                        <th style="padding:8px;">Komentarz</th>
                        <th style="padding:8px;">Słowo</th>
                        <th style="padding:8px;">Status</th>
                        <th style="padding:8px;">Post</th>
                    </tr>
                </thead>
                <tbody>
                    {''.join(rows_html)}
                </tbody>
            </table>
        </div>
        """
        return self.send_email(subject, html_body, "\n".join(lines_text))

    def send_test_email(self) -> bool:
        subject = f"✅ {APP_NAME} Comment-to-DM Bot — Test e-mail"
        html_body = (
            f"<h2>✅ {html.escape(APP_NAME)} Comment-to-DM Bot działa!</h2>"
            "<p>Konfiguracja e-mail w GitHub Actions / lokalnie jest poprawna.</p>"
        )
        text_body = f"{APP_NAME} Comment-to-DM Bot — testowe powiadomienie e-mail działa poprawnie!"
        return self.send_email(subject, html_body, text_body)
