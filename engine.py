import time
from typing import Any, Dict, List, Optional

from ai_helper import personalize_dm_with_gemini
from config import (
    MAX_COMMENT_AGE_DAYS,
    MAX_DMS_PER_RUN,
    REPLY_DELAY_SECONDS,
)
from database import (
    has_user_received_dm_on_post,
    is_comment_processed,
    record_comment,
)
from matcher import match_comment, pick_public_reply, render_dm_text
from meta_client import MetaApiError, MetaGraphClient, is_within_private_reply_window
from notifiers.console_notifier import ConsoleNotifier


def process_comments(
    comments: List[Dict[str, Any]],
    rules: List[Dict[str, Any]],
    meta_client: MetaGraphClient,
    *,
    mock: bool = False,
    dry_run: bool = False,
    db_path: Optional[str] = None,
    max_dms: int = MAX_DMS_PER_RUN,
    reply_delay: float = REPLY_DELAY_SECONDS,
    max_age_days: int = MAX_COMMENT_AGE_DAYS,
    ntfy=None,
    telegram=None,
) -> Dict[str, Any]:
    """
    Przetwarza listę komentarzy z Instagrama i Facebooka:
    1. Deduplikacja po comment_id
    2. Weryfikacja 7-dniowego okna Meta Private Replies
    3. Dopasowanie słów kluczowych z rules.json
    4. Deduplikacja (platform, post_id, user) — maksymalnie 1 DM na użytkownika pod tym samym postem
    5. Wysyłka Private Reply DM + opcjonalna publiczna odpowiedź pod komentarzem
    """
    sent_events: List[Dict[str, Any]] = []
    error_events: List[Dict[str, Any]] = []
    stats = {
        "scanned": len(comments),
        "already_processed": 0,
        "expired": 0,
        "no_match": 0,
        "duplicate_user": 0,
        "dm_sent": 0,
        "public_replies_sent": 0,
        "errors": 0,
        "rate_limit_stopped": 0,
    }

    for comment in comments:
        comment_id = str(comment.get("comment_id") or "").strip()
        platform = str(comment.get("platform") or "").strip().lower()
        post_id = str(comment.get("post_id") or "").strip()
        post_url = str(comment.get("post_url") or "")
        author_id = str(comment.get("author_id") or "")
        author_username = str(comment.get("author_username") or "użytkownik")
        comment_text = str(comment.get("text") or "").strip()
        timestamp = comment.get("timestamp")

        if not comment_id or not platform or not post_id:
            continue

        # 1. Deduplikacja po comment_id
        if not dry_run and is_comment_processed(comment_id, db_path=db_path):
            stats["already_processed"] += 1
            continue

        # 2. Sprawdzenie okna czasowego Meta Private Replies (do 7 dni; domyślnie 6)
        if not is_within_private_reply_window(timestamp, max_age_days=max_age_days):
            stats["expired"] += 1
            if not dry_run:
                record_comment(
                    comment_id=comment_id,
                    platform=platform,
                    post_id=post_id,
                    post_url=post_url,
                    author_id=author_id,
                    author_username=author_username,
                    comment_text=comment_text,
                    status="SKIPPED_EXPIRED",
                    db_path=db_path,
                )
            continue

        # 3. Dopasowanie reguły i słowa kluczowego
        matched = match_comment(platform, post_id, comment_text, rules)
        if not matched:
            stats["no_match"] += 1
            if not dry_run:
                record_comment(
                    comment_id=comment_id,
                    platform=platform,
                    post_id=post_id,
                    post_url=post_url,
                    author_id=author_id,
                    author_username=author_username,
                    comment_text=comment_text,
                    status="NO_MATCH",
                    db_path=db_path,
                )
            continue

        rule, matched_keyword = matched
        rule_id = str(rule.get("id") or "default")
        rule_name = str(rule.get("name") or rule_id)

        # 4. Ochrona przed wielokrotnym DM dla tego samego użytkownika pod jednym postem
        if rule.get("dedupe_per_post_user", True) and not dry_run:
            if has_user_received_dm_on_post(
                platform,
                post_id,
                author_id=author_id,
                author_username=author_username,
                db_path=db_path,
            ):
                stats["duplicate_user"] += 1
                record_comment(
                    comment_id=comment_id,
                    platform=platform,
                    post_id=post_id,
                    post_url=post_url,
                    author_id=author_id,
                    author_username=author_username,
                    comment_text=comment_text,
                    matched_rule_id=rule_id,
                    matched_keyword=matched_keyword,
                    status="SKIPPED_DUPLICATE_USER",
                    db_path=db_path,
                )
                continue

        # 5. Bezpiecznik limitu wysyłek w jednym cyklu
        if stats["dm_sent"] >= max_dms:
            stats["rate_limit_stopped"] += 1
            continue

        # 6. Wygenerowanie treści DM i publicznej odpowiedzi
        dm_text = render_dm_text(
            str(rule.get("dm_text") or ""),
            username=author_username,
            keyword=matched_keyword,
        )
        if rule.get("ai_personalize", False) and not mock:
            dm_text = personalize_dm_with_gemini(
                base_dm=dm_text,
                comment_text=comment_text,
                username=author_username,
                platform=platform,
            )

        quick_replies = rule.get("quick_replies") or []
        public_reply_text = pick_public_reply(rule, username=author_username) or ""

        event: Dict[str, Any] = {
            "comment_id": comment_id,
            "platform": platform,
            "post_id": post_id,
            "post_url": post_url,
            "author_id": author_id,
            "author_username": author_username,
            "comment_text": comment_text,
            "rule_id": rule_id,
            "rule_name": rule_name,
            "matched_keyword": matched_keyword,
            "dm_text": dm_text,
            "public_reply_text": public_reply_text,
            "dm_message_id": "",
            "public_reply_id": "",
            "status": "",
            "error_message": "",
        }

        if dry_run:
            event["status"] = "DRY_RUN"
            ConsoleNotifier.print_event(event)
            sent_events.append(event)
            stats["dm_sent"] += 1
            if public_reply_text:
                stats["public_replies_sent"] += 1
            continue

        if mock:
            event["status"] = "DM_SENT_MOCK"
            event["dm_message_id"] = f"mock_dm_{comment_id}"
            if public_reply_text:
                event["public_reply_id"] = f"mock_reply_{comment_id}"
                stats["public_replies_sent"] += 1
            ConsoleNotifier.print_event(event)
            record_comment(
                comment_id=comment_id,
                platform=platform,
                post_id=post_id,
                post_url=post_url,
                author_id=author_id,
                author_username=author_username,
                comment_text=comment_text,
                matched_rule_id=rule_id,
                matched_keyword=matched_keyword,
                status=event["status"],
                dm_message_id=event["dm_message_id"],
                dm_text=dm_text,
                public_reply_id=event["public_reply_id"],
                public_reply_text=public_reply_text,
                db_path=db_path,
            )
            sent_events.append(event)
            stats["dm_sent"] += 1
            continue

        # 7. Prawdziwa wysyłka do Meta Graph API
        try:
            dm_msg_id, _ = meta_client.send_private_reply(
                platform=platform,
                comment_id=comment_id,
                dm_text=dm_text,
                quick_replies=quick_replies,
            )
            event["dm_message_id"] = dm_msg_id
            event["status"] = "DM_SENT"
            stats["dm_sent"] += 1

            # Opcjonalna publiczna odpowiedź pod komentarzem
            if public_reply_text:
                try:
                    pub_id, _ = meta_client.send_public_reply(
                        platform=platform,
                        comment_id=comment_id,
                        reply_text=public_reply_text,
                    )
                    event["public_reply_id"] = pub_id
                    stats["public_replies_sent"] += 1
                except MetaApiError as pub_err:
                    # DM już poszedł — logujemy błąd publicznej odpowiedzi bez cofania sukcesu DM
                    event["error_message"] = f"Public reply error: {pub_err}"

            ConsoleNotifier.print_event(event)
            record_comment(
                comment_id=comment_id,
                platform=platform,
                post_id=post_id,
                post_url=post_url,
                author_id=author_id,
                author_username=author_username,
                comment_text=comment_text,
                matched_rule_id=rule_id,
                matched_keyword=matched_keyword,
                status=event["status"],
                dm_message_id=event["dm_message_id"],
                dm_text=dm_text,
                public_reply_id=event["public_reply_id"],
                public_reply_text=public_reply_text,
                error_message=event["error_message"],
                db_path=db_path,
            )
            sent_events.append(event)

            if ntfy and ntfy.is_configured():
                ntfy.notify_dm_sent(event)
            if telegram and telegram.is_configured():
                telegram.notify_dm_sent(event)

            if reply_delay > 0:
                time.sleep(reply_delay)

        except MetaApiError as e:
            event["status"] = "ERROR"
            event["error_message"] = f"[{e.error_code}] {e}"
            stats["errors"] += 1
            ConsoleNotifier.print_event(event)
            # Zapisujemy błąd (szczególnie 10900=już odpowiedziano, 230/200=użytkownik zablokował DM),
            # żeby uniknąć pętli błędów w kolejnych cyklach
            if e.error_code in (10, 200, 230, 551, 10900):
                record_comment(
                    comment_id=comment_id,
                    platform=platform,
                    post_id=post_id,
                    post_url=post_url,
                    author_id=author_id,
                    author_username=author_username,
                    comment_text=comment_text,
                    matched_rule_id=rule_id,
                    matched_keyword=matched_keyword,
                    status="ERROR",
                    error_message=event["error_message"],
                    db_path=db_path,
                )
            error_events.append(event)

    return {
        "stats": stats,
        "sent_events": sent_events,
        "error_events": error_events,
    }
