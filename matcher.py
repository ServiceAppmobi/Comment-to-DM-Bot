import json
import random
import re
import unicodedata
from typing import Any, Dict, List, Optional, Tuple
from config import APP_NAME, APP_URL, ANDROID_STORE_URL, IOS_STORE_URL, RULES_PATH


def normalize_text(text: str) -> str:
    """Zamienia tekst na małe litery i usuwa znaki diakrytyczne (ą->a, ç->c, ó->o itd.)."""
    if not text:
        return ""
    decomposed = unicodedata.normalize("NFKD", text.lower())
    without_accents = "".join(ch for ch in decomposed if not unicodedata.combining(ch))
    # Polska litera 'ł' nie rozkłada się w NFKD
    without_accents = without_accents.replace("ł", "l")
    return without_accents.strip()


def load_rules(rules_path: Optional[str] = None) -> List[Dict[str, Any]]:
    """Wczytuje listę reguł Comment-to-DM z pliku rules.json."""
    path = rules_path or RULES_PATH
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    rules = data.get("rules", []) if isinstance(data, dict) else data
    return [r for r in rules if isinstance(r, dict) and r.get("enabled", True)]


def _keyword_matches(normalized_comment: str, keyword: str, match_mode: str) -> bool:
    norm_kw = normalize_text(keyword)
    if not norm_kw:
        return False

    if match_mode == "exact":
        cleaned_comment = re.sub(r"[^\w\s]", " ", normalized_comment)
        cleaned_comment = re.sub(r"\s+", " ", cleaned_comment).strip()
        return cleaned_comment == norm_kw

    # Domyślny tryb "contains": dopasowanie po granicach wyrazów (żeby "app" nie łapało "happy")
    pattern = r"(?<!\w)" + re.escape(norm_kw) + r"(?!\w)"
    return re.search(pattern, normalized_comment) is not None


def match_comment(
    platform: str,
    post_id: str,
    comment_text: str,
    rules: List[Dict[str, Any]],
) -> Optional[Tuple[Dict[str, Any], str]]:
    """
    Zwraca pierwszą pasującą regułę oraz dopasowane słowo kluczowe (rule, matched_keyword).
    Jeśli komentarz nie pasuje do żadnej reguły, zwraca None.
    """
    norm_comment = normalize_text(comment_text)
    if not norm_comment:
        return None

    for rule in rules:
        platforms = [p.lower() for p in rule.get("platforms", ["instagram", "facebook"])]
        if platform.lower() not in platforms:
            continue

        post_ids = [str(pid) for pid in rule.get("post_ids", []) if str(pid).strip()]
        if post_ids and str(post_id) not in post_ids:
            continue

        match_mode = str(rule.get("match_mode", "contains")).lower()
        if match_mode == "any":
            return rule, "*"

        for kw in rule.get("keywords", []):
            if _keyword_matches(norm_comment, str(kw), match_mode):
                return rule, str(kw)

    return None


def render_dm_text(
    template: str,
    username: str,
    keyword: str,
    extra_vars: Optional[Dict[str, str]] = None,
) -> str:
    """Podstawia zmienne szablonu ({username}, {app_name}, {app_url}, ...)."""
    clean_user = (username or "").lstrip("@").strip() or "znajomy"
    values = {
        "username": clean_user,
        "app_name": APP_NAME,
        "app_url": APP_URL,
        "android_url": ANDROID_STORE_URL,
        "ios_url": IOS_STORE_URL,
        "keyword": keyword,
    }
    if extra_vars:
        values.update(extra_vars)

    result = template
    for key, val in values.items():
        result = result.replace("{" + key + "}", str(val))
    return result


def pick_public_reply(rule: Dict[str, Any], username: str = "") -> Optional[str]:
    """Losuje jedną z wersji publicznej odpowiedzi na komentarz (anty-spam)."""
    if not rule.get("public_reply_enabled", False):
        return None
    replies = [r for r in rule.get("public_replies", []) if isinstance(r, str) and r.strip()]
    if not replies:
        return None
    chosen = random.choice(replies)
    return render_dm_text(chosen, username=username, keyword="")
