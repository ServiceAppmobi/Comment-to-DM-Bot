import sqlite3
from typing import Dict, Any, Optional
from config import DB_PATH


def _connect(db_path: Optional[str] = None) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path or DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db(db_path: Optional[str] = None) -> None:
    """Tworzy tabele SQLite do śledzenia przetworzonych komentarzy i wysłanych DM."""
    conn = _connect(db_path)
    cursor = conn.cursor()
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS processed_comments (
            comment_id TEXT PRIMARY KEY,
            platform TEXT NOT NULL,
            post_id TEXT NOT NULL,
            post_url TEXT,
            author_id TEXT,
            author_username TEXT,
            comment_text TEXT,
            matched_rule_id TEXT,
            matched_keyword TEXT,
            status TEXT NOT NULL,
            dm_message_id TEXT,
            dm_text TEXT,
            public_reply_id TEXT,
            public_reply_text TEXT,
            error_message TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
        """
    )
    cursor.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_post_author_status
        ON processed_comments (platform, post_id, author_id, status)
        """
    )
    cursor.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_post_username_status
        ON processed_comments (platform, post_id, author_username, status)
        """
    )
    conn.commit()
    conn.close()


def is_comment_processed(comment_id: str, db_path: Optional[str] = None) -> bool:
    """Sprawdza, czy komentarz był już przetwarzany w dowolnym poprzednim cyklu."""
    conn = _connect(db_path)
    cursor = conn.cursor()
    cursor.execute(
        "SELECT 1 FROM processed_comments WHERE comment_id = ? LIMIT 1",
        (comment_id,),
    )
    found = cursor.fetchone() is not None
    conn.close()
    return found


def has_user_received_dm_on_post(
    platform: str,
    post_id: str,
    author_id: str = "",
    author_username: str = "",
    db_path: Optional[str] = None,
) -> bool:
    """Chroni przed wysłaniem dwóch DM do tej samej osoby pod jednym postem."""
    conn = _connect(db_path)
    cursor = conn.cursor()

    if author_id:
        cursor.execute(
            """
            SELECT 1 FROM processed_comments
            WHERE platform = ? AND post_id = ? AND author_id = ?
              AND status IN ('DM_SENT', 'DM_SENT_MOCK')
            LIMIT 1
            """,
            (platform, post_id, author_id),
        )
        if cursor.fetchone() is not None:
            conn.close()
            return True

    if author_username:
        cursor.execute(
            """
            SELECT 1 FROM processed_comments
            WHERE platform = ? AND post_id = ? AND LOWER(author_username) = LOWER(?)
              AND status IN ('DM_SENT', 'DM_SENT_MOCK')
            LIMIT 1
            """,
            (platform, post_id, author_username),
        )
        if cursor.fetchone() is not None:
            conn.close()
            return True

    conn.close()
    return False


def record_comment(
    comment_id: str,
    platform: str,
    post_id: str,
    status: str,
    post_url: str = "",
    author_id: str = "",
    author_username: str = "",
    comment_text: str = "",
    matched_rule_id: str = "",
    matched_keyword: str = "",
    dm_message_id: str = "",
    dm_text: str = "",
    public_reply_id: str = "",
    public_reply_text: str = "",
    error_message: str = "",
    db_path: Optional[str] = None,
) -> None:
    """Zapisuje wynik przetworzenia komentarza w bazie SQLite."""
    conn = _connect(db_path)
    cursor = conn.cursor()
    cursor.execute(
        """
        INSERT OR REPLACE INTO processed_comments (
            comment_id, platform, post_id, post_url, author_id, author_username,
            comment_text, matched_rule_id, matched_keyword, status,
            dm_message_id, dm_text, public_reply_id, public_reply_text, error_message
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            comment_id,
            platform,
            post_id,
            post_url,
            author_id,
            author_username,
            comment_text[:500],
            matched_rule_id,
            matched_keyword,
            status,
            dm_message_id,
            dm_text[:1500],
            public_reply_id,
            public_reply_text[:500],
            error_message[:500],
        ),
    )
    conn.commit()
    conn.close()


def get_stats(db_path: Optional[str] = None) -> Dict[str, Any]:
    """Zwraca zbiorcze statystyki działania bota Comment-to-DM."""
    conn = _connect(db_path)
    cursor = conn.cursor()

    def _count(where: str = "", params: tuple = ()) -> int:
        sql = "SELECT COUNT(*) FROM processed_comments"
        if where:
            sql += f" WHERE {where}"
        cursor.execute(sql, params)
        return int(cursor.fetchone()[0])

    stats = {
        "total_processed": _count(),
        "dm_sent": _count("status = 'DM_SENT'"),
        "dm_sent_mock": _count("status = 'DM_SENT_MOCK'"),
        "instagram_dm_sent": _count(
            "platform = 'instagram' AND status IN ('DM_SENT', 'DM_SENT_MOCK')"
        ),
        "facebook_dm_sent": _count(
            "platform = 'facebook' AND status IN ('DM_SENT', 'DM_SENT_MOCK')"
        ),
        "public_replies_sent": _count("public_reply_id IS NOT NULL AND public_reply_id != ''"),
        "skipped_no_match": _count("status = 'NO_MATCH'"),
        "skipped_duplicate_user": _count("status = 'SKIPPED_DUPLICATE_USER'"),
        "skipped_expired": _count("status = 'SKIPPED_EXPIRED'"),
        "errors": _count("status = 'ERROR'"),
    }
    conn.close()
    return stats
