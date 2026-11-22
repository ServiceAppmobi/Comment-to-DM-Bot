import os

BASE_DIR = os.path.dirname(os.path.abspath(__file__))


def _env_bool(name: str, default: bool = False) -> bool:
    raw = os.getenv(name)
    if raw is None or raw.strip() == "":
        return default
    return raw.strip().lower() in ("true", "1", "yes", "on")


def _env_int(name: str, default: int) -> int:
    raw = os.getenv(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        return int(raw.strip())
    except ValueError:
        return default


def _env_float(name: str, default: float) -> float:
    raw = os.getenv(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        return float(raw.strip())
    except ValueError:
        return default


# ==============================================================================
# BRANDING & LINKI SERVICEAPP
# ==============================================================================
APP_NAME = os.getenv("APP_NAME") or "ServiceApp"
APP_URL = os.getenv("APP_URL") or "https://serviceapp.mobi"
ANDROID_STORE_URL = (
    os.getenv("ANDROID_STORE_URL")
    or "https://play.google.com/store/apps/details?id=com.serviceapp.mobile"
)
IOS_STORE_URL = (
    os.getenv("IOS_STORE_URL")
    or "https://apps.apple.com/pl/app/serviceapp/id0000000000"
)

# ==============================================================================
# META GRAPH API (INSTAGRAM & FACEBOOK)
# ==============================================================================
META_GRAPH_API_VERSION = os.getenv("META_GRAPH_API_VERSION") or "v21.0"
META_ACCESS_TOKEN = (os.getenv("META_ACCESS_TOKEN") or "").strip()
FB_PAGE_ACCESS_TOKEN = (os.getenv("FB_PAGE_ACCESS_TOKEN") or "").strip() or META_ACCESS_TOKEN

IG_USER_ID = (os.getenv("IG_USER_ID") or "").strip()
IG_USERNAME = (os.getenv("IG_USERNAME") or "").strip().lstrip("@").lower()
FB_PAGE_ID = (os.getenv("FB_PAGE_ID") or "").strip()

INSTAGRAM_ENABLED = _env_bool("INSTAGRAM_ENABLED", True)
FACEBOOK_ENABLED = _env_bool("FACEBOOK_ENABLED", True)

# ==============================================================================
# LIMITY I ANTY-SPAM
# ==============================================================================
MAX_POSTS_PER_PLATFORM = _env_int("MAX_POSTS_PER_PLATFORM", 10)
MAX_COMMENTS_PER_POST = _env_int("MAX_COMMENTS_PER_POST", 50)
MAX_DMS_PER_RUN = _env_int("MAX_DMS_PER_RUN", 25)
REPLY_DELAY_SECONDS = _env_float("REPLY_DELAY_SECONDS", 1.5)
MAX_COMMENT_AGE_DAYS = _env_int("MAX_COMMENT_AGE_DAYS", 6)
DRY_RUN_DEFAULT = _env_bool("DRY_RUN", False)

# ==============================================================================
# WEBHOOK SERVER (OPCJONALNY TRYB LIVE HTTP)
# ==============================================================================
META_VERIFY_TOKEN = (os.getenv("META_VERIFY_TOKEN") or "serviceapp_comment_dm_verify_token").strip()
META_APP_SECRET = (os.getenv("META_APP_SECRET") or "").strip()
WEBHOOK_HOST = os.getenv("WEBHOOK_HOST") or "0.0.0.0"
WEBHOOK_PORT = _env_int("WEBHOOK_PORT", 8089)

# ==============================================================================
# AI / GEMINI (OPCJONALNE)
# ==============================================================================
GEMINI_API_KEY = (os.getenv("GEMINI_API_KEY") or "").strip()
GEMINI_MODEL = os.getenv("GEMINI_MODEL") or "gemini-2.5-flash"

# ==============================================================================
# POWIADOMIENIA (E-MAIL, NTFY, TELEGRAM)
# ==============================================================================
RESEND_API_KEY = (os.getenv("RESEND_API_KEY") or "").strip()
EMAIL_RECIPIENT = (os.getenv("EMAIL_RECIPIENT") or "karolak.pawel@gmail.com").strip()
EMAIL_SENDER = (os.getenv("EMAIL_SENDER") or "onboarding@resend.dev").strip()

SMTP_HOST = os.getenv("SMTP_HOST") or "smtp.resend.com"
SMTP_PORT = _env_int("SMTP_PORT", 465)
SMTP_USER = os.getenv("SMTP_USER") or "resend"
SMTP_PASSWORD = (os.getenv("SMTP_PASSWORD") or "").strip()
SMTP_USE_TLS = _env_bool("SMTP_USE_TLS", True)

NTFY_TOPIC = (os.getenv("NTFY_TOPIC") or "").strip()
NTFY_SERVER = (os.getenv("NTFY_SERVER") or "https://ntfy.sh").strip()

TELEGRAM_BOT_TOKEN = (os.getenv("TELEGRAM_BOT_TOKEN") or "").strip()
TELEGRAM_CHAT_ID = (os.getenv("TELEGRAM_CHAT_ID") or "").strip()

# ==============================================================================
# ŚCIEŻKI PLIKÓW
# ==============================================================================
RULES_PATH = os.getenv("RULES_PATH") or os.path.join(BASE_DIR, "rules.json")
DB_PATH = os.getenv("DB_PATH") or os.path.join(BASE_DIR, "comment_dm.db")
